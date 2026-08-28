import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDeckConfig } from '../config.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { TerminalRegistry } from '../discovery/terminals/index.js';
import type { CoordinationService } from '../coordination/service.js';
import type { VsCodeBridge } from '../discovery/terminals/vscode.js';
import type { DiscoveryPoller } from '../discovery/poller.js';
import type { ModelCatalog } from '../sessions/model-catalog.js';
import { registerRoutes, type RouteContext } from './routes.js';
import { classify, isAllowedOrigin, isLoopbackHostHeader, TOKEN_HEADER } from './connection-trust.js';

// Re-exported for existing callers (ws.test.ts imports both from here); the
// canonical implementations now live in connection-trust.ts so classify()
// can use them without an app.ts <-> connection-trust.ts import cycle.
export { isAllowedOrigin, isLoopbackHostHeader };

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export interface AppContext {
  config: AgentDeckConfig;
  manager?: SessionManager;
  store?: Store;
  terminals?: TerminalRegistry;
  coordination?: CoordinationService;
  vscode?: VsCodeBridge;
  discovery?: DiscoveryPoller;
  installVsCode?: RouteContext['installVsCode'];
  publish?: RouteContext['publish'];
  modelCatalog?: ModelCatalog;
  /**
   * The tailnet hostname/IP detected at startup (see server/tailscale.ts),
   * or undefined when no Tailscale interface was found. Feeds classify()
   * for the host allow-check, the origin check, the CSP connect-src, and
   * (via routes.ts) GET /api/connection.
   */
  remoteHost?: string;
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    // ConnectionTrust decides once (host + origin + token); the REST host
    // check, the CSP connect-src below, the WebSocket upgrade (ws.ts), and
    // GET /api/connection (routes.ts) all defer to the same classify() call
    // so a newly allowed host can't be added in one place and missed in
    // another (see docs/specs, "ConnectionTrust").
    const trust = classify(
      { host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER] as string | undefined },
      { remoteHost: ctx.remoteHost, token: ctx.config.tailscaleToken },
    );
    const allowedHost = trust.kind !== 'denied';
    const connectPolicy = allowedHost ? `connect-src 'self' ws://${req.headers.host}` : "connect-src 'self'";
    reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': `${CONTENT_SECURITY_POLICY}; ${connectPolicy}`,
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'referrer-policy': 'no-referrer',
      'x-dns-prefetch-control': 'off',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    if (!allowedHost) {
      return reply.code(403).send({ error: 'forbidden host' });
    }
    // Remote-but-unauthenticated (no/invalid token) may still load the SPA
    // shell and static assets — otherwise the phone could never load the
    // page that prompts for a token — but every /api/* call requires the
    // token, except /api/connection itself, which is how the client
    // discovers "you're remote, please enter a token" in the first place.
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    const requiresRemoteToken = pathname.startsWith('/api/') && pathname !== '/api/connection';
    if (requiresRemoteToken && trust.kind === 'remote' && trust.capabilities.size === 0) {
      return reply.code(403).send({ error: 'a valid tailnet token is required' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  if (ctx.manager) registerRoutes(app, {
    manager: ctx.manager,
    config: ctx.config,
    store: ctx.store,
    terminals: ctx.terminals,
    coordination: ctx.coordination,
    vscode: ctx.vscode,
    discovery: ctx.discovery,
    installVsCode: ctx.installVsCode,
    publish: ctx.publish,
    modelCatalog: ctx.modelCatalog,
    remoteHost: ctx.remoteHost,
  });

  // Production: serve the built SPA from dist/ui (hand-rolled to keep the
  // dependency list minimal — no @fastify/static). Dev uses vite.
  const distDir = path.resolve(import.meta.dirname, '../../dist/ui');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distDir)) {
    app.get('/*', async (req, reply) => {
      const urlPath = (req.params as Record<string, string>)['*'] || 'index.html';
      // resolve + prefix check prevents path traversal out of distDir
      const file = path.resolve(distDir, urlPath);
      const target = file.startsWith(distDir + path.sep) || file === path.join(distDir, 'index.html')
        ? file
        : path.join(distDir, 'index.html');
      const existing = fs.existsSync(target) && fs.statSync(target).isFile()
        ? target
        : path.join(distDir, 'index.html'); // SPA fallback
      reply.type(MIME[path.extname(existing)] ?? 'application/octet-stream');
      return fs.promises.readFile(existing);
    });
  }

  return app;
}
