import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDeckConfig } from '../config.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { TerminalRegistry } from '../discovery/terminals/index.js';
import type { CoordinationService } from '../coordination/service.js';
import { registerRoutes } from './routes.js';

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
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true }));

  if (ctx.manager) registerRoutes(app, {
    manager: ctx.manager,
    config: ctx.config,
    store: ctx.store,
    terminals: ctx.terminals,
    coordination: ctx.coordination,
  });

  // Production: serve the built SPA from dist/ui (hand-rolled to stay within
  // the DESIGN §5 dependency list — no @fastify/static). Dev uses vite.
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
