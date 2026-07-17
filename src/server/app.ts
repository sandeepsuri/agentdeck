import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDeckConfig } from '../config.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { TerminalRegistry } from '../discovery/terminals/index.js';
import type { CoordinationService } from '../coordination/service.js';
import type { VsCodeBridge } from '../discovery/terminals/vscode.js';
import { registerRoutes, type RouteContext } from './routes.js';

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

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // non-browser client
  try {
    return isLoopbackHostHeader(new URL(origin).host);
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
  installVsCode?: RouteContext['installVsCode'];
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden host' });
    }
    if (!isAllowedOrigin(req.headers.origin)) {
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
    installVsCode: ctx.installVsCode,
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
