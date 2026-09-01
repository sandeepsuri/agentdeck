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
import type { WorkEngine } from '../work-engine/types.js';
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

/**
 * Code-review finding: an authenticated remote connection had the exact
 * same REST surface as local — launching sessions, discarding uncommitted
 * git changes, installing hooks, PATCHing settings (including the OpenAI
 * key), publish/PR, stop/restart — because the onRequest hook below only
 * ever checked "is this connection authenticated at all", never "is this
 * specific route part of what a remote connection is for". The spec's
 * Decisions table is explicit about the intended surface: "Mobile
 * capability | Reflowed text view, free-text composer, fixed control-key
 * buttons" — nothing about session launch or app configuration. A valid
 * tailnet token authenticates a connection; it does not grant it the same
 * administrative capability as sitting at the machine.
 *
 * This is an explicit allowlist (not a denylist) of exactly the /api/*
 * routes the mobile UI (tickets 13/14) actually calls — GET /api/sessions
 * (MobileWorkspace's session list/picker) and POST .../send (the
 * composer) — plus the always-safe, non-sensitive health check. Everything
 * else under /api/* is local-only by default; a new route added later
 * doesn't need to remember to exclude remote, it has to be deliberately
 * added here to include it. GET /api/connection is handled separately
 * above this check (it must work pre-authentication) and WS traffic isn't
 * an /api/* path at all — ws.ts enforces its own capability checks
 * (raw-write on 'input', local-only for raw output/replay/tile_preview).
 *
 * Ticket 07: GET /api/runs/attention and the three POST .../attention/:id/*
 * routes are the same deliberate, narrow shape — a mobile client can read
 * the minimal RunAttentionItem queue (objective/reason/correlation only,
 * see attention.ts's deriveRunAttentionItems) and resolve one request, but
 * every other Run route (list/get/submit/prepare/start/cancel, which would
 * expose the Repository path, budget, and full spec) stays local-only.
 */
function isRemoteAllowedRoute(method: string, pathname: string): boolean {
  if (method === 'GET' && (pathname === '/api/health' || pathname === '/api/sessions' || pathname === '/api/runs/attention')) return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/send$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/runs\/[^/]+\/attention\/[^/]+\/(approve|deny|input)$/.test(pathname)) return true;
  return false;
}

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
  /** Ticket 07: feeds GET /api/companion's runAttention field (routes.ts). Never registered separately — registerWorkRoutes(app, workEngine) in index.ts owns the actual /api/runs* routes. */
  workEngine?: WorkEngine;
  /**
   * The tailnet hostname and IP detected at startup (see server/tailscale.ts),
   * or an empty/undefined set when no Tailscale interface was found. Feeds classify()
   * for the host allow-check, the origin check, the CSP connect-src, and
   * (via routes.ts) GET /api/connection.
   */
  remoteHosts?: readonly string[];
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
      { remoteHosts: ctx.remoteHosts, token: ctx.config.tailscaleToken },
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
    const isApiRoute = pathname.startsWith('/api/');
    const requiresRemoteToken = isApiRoute && pathname !== '/api/connection';
    if (requiresRemoteToken && trust.kind === 'remote' && trust.capabilities.size === 0) {
      return reply.code(403).send({ error: 'a valid tailnet token is required' });
    }
    // A remote connection is scoped to exactly what the mobile experience
    // needs, not the full local REST surface — see isRemoteAllowedRoute's
    // comment above. Only reached once a remote connection is already
    // authenticated (the check above already rejected an empty-capability
    // remote request), so this narrows further rather than duplicating it.
    if (requiresRemoteToken && trust.kind === 'remote' && !isRemoteAllowedRoute(req.method, pathname)) {
      return reply.code(403).send({ error: 'this endpoint is not available on a remote connection' });
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
    workEngine: ctx.workEngine,
    remoteHosts: ctx.remoteHosts,
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
