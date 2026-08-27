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

/**
 * The server binds to 127.0.0.1, but browsers will happily send requests
 * here from any web page (DNS rebinding defeats same-origin for the REST
 * API; WebSocket upgrades skip CORS entirely). Only loopback Host/Origin
 * values are allowed; requests without an Origin (curl, CLI) are fine
 * because they already run as the local user.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0] ?? '';
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export function isAllowedOrigin(origin: string | undefined, requestHost?: string): boolean {
  if (origin === undefined) return true; // non-browser client
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin !== origin || !isLoopbackHostHeader(parsed.host)) return false;
    if (requestHost === undefined) return true;
    const requested = new URL(`${parsed.protocol}//${requestHost}`);
    return parsed.hostname === requested.hostname && parsed.port === requested.port;
  } catch {
    return false;
  }
}

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
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const allowedHost = isLoopbackHostHeader(req.headers.host);
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
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden origin' });
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
