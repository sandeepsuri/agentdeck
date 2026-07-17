// REST routes (T4): session CRUD/lifecycle. Terminal I/O goes over /ws.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { AgentDeckConfig } from '../config.js';
import { expandTilde } from '../config.js';
import { checkoutExistingBranch, scanRepos } from '../git/scan.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import { AutomationDeniedError, type TerminalRegistry } from '../discovery/terminals/index.js';
import type { AgentType, LaunchSpec } from '../types.js';
import type { CoordinationService } from '../coordination/service.js';
import { deriveClaims } from '../coordination/status.js';
import os from 'node:os';
import path from 'node:path';
import { installClaudeHooks, installCodexHooks, uninstallClaudeHooks, uninstallCodexHooks } from '../hooks/install.js';
import { deriveConflicts } from '../conflicts/derive.js';

const HOOK_PATH = path.resolve(import.meta.dirname, '../../bin/agentdeck-hook.mjs');

function parseLaunchSpec(body: unknown): LaunchSpec | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (b.agent !== 'claude' && b.agent !== 'codex') return 'agent must be "claude" or "codex"';
  if (typeof b.cwd !== 'string' || b.cwd === '') return 'cwd is required';
  const cwd = expandTilde(b.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return `cwd is not a directory: ${cwd}`;
  }
  const spec: LaunchSpec = { agent: b.agent as AgentType, cwd };
  if (typeof b.initialPrompt === 'string' && b.initialPrompt !== '') spec.initialPrompt = b.initialPrompt;
  if (typeof b.name === 'string' && b.name !== '') spec.name = b.name;
  if (typeof b.branch === 'string' && b.branch !== '') spec.branch = b.branch;
  if (Array.isArray(b.extraArgs) && b.extraArgs.every((a) => typeof a === 'string')) {
    spec.extraArgs = b.extraArgs as string[];
  }
  if (typeof b.env === 'object' && b.env !== null) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    spec.env = env;
  }
  return spec;
}

export interface RouteContext {
  manager: SessionManager;
  config: AgentDeckConfig;
  store?: Store;
  terminals?: TerminalRegistry;
  coordination?: CoordinationService;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { manager } = ctx;
  app.get('/api/sessions', async () => manager.listSessions());

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (typeof req.body !== 'object' || req.body === null) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    const { name } = req.body as { name?: unknown };
    if (name !== undefined && typeof name !== 'string') {
      return reply.code(400).send({ error: 'name must be a string' });
    }
    const session = manager.renameSession(id, name?.trim() || undefined);
    return session ?? reply.code(404).send({ error: 'no such session' });
  });

  app.get('/api/repos', async () => {
    if (!ctx.store) return [];
    try {
      const repos = await scanRepos(ctx.config.projectsDir, ctx.store);
      await ctx.coordination?.syncRepos(repos);
      return repos;
    } catch {
      return ctx.store.listRepos();
    }
  });

  app.get('/api/events', async () => ctx.store?.listEvents({ limit: 100 }) ?? []);
  app.get('/api/claims', async () => deriveClaims(ctx.store?.listEvents({ limit: 1000 }) ?? []));
  app.get('/api/conflicts', async () => ctx.store ? deriveConflicts(
    manager.listSessions(), ctx.store.listRepos(),
    deriveClaims(ctx.store.listEvents({ limit: 1000 })), ctx.store.listTasks(),
  ) : []);

  app.get('/api/terminals/status', async () => ({
    automationHint: ctx.terminals?.automationHint(),
  }));

  app.post('/api/sessions', async (req, reply) => {
    const spec = parseLaunchSpec(req.body);
    if (typeof spec === 'string') return reply.code(400).send({ error: spec });
    try {
      if (spec.branch) await checkoutExistingBranch(spec.cwd, spec.branch);
      if (spec.agent === 'codex') {
        spec.extraArgs = [...(spec.extraArgs ?? []), '-c', `notify=${JSON.stringify(['node', HOOK_PATH])}`];
      }
      const session = await manager.launch(spec);
      return reply.code(201).send(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/api/hooks/install', async (req, reply) => {
    const body = req.body as { repoPath?: unknown; user?: unknown } | null;
    if (!body || typeof body.repoPath !== 'string') return reply.code(400).send({ error: 'repoPath is required' });
    installClaudeHooks(body.repoPath, HOOK_PATH);
    if (body.user === true) installCodexHooks(path.join(os.homedir(), '.codex', 'config.toml'), HOOK_PATH);
    return { ok: true };
  });

  app.post('/api/hooks/uninstall', async (req, reply) => {
    const body = req.body as { repoPath?: unknown; user?: unknown } | null;
    if (!body || typeof body.repoPath !== 'string') return reply.code(400).send({ error: 'repoPath is required' });
    uninstallClaudeHooks(body.repoPath);
    if (body.user === true) uninstallCodexHooks(path.join(os.homedir(), '.codex', 'config.toml'));
    return { ok: true };
  });

  app.post('/api/sessions/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!manager.getSession(id)) return reply.code(404).send({ error: 'no such session' });
    await manager.stop(id);
    return { ok: true }; // the session row is removed on exit
  });

  app.post('/api/sessions/:id/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'managed' || !session.launchSpec) {
      return reply.code(400).send({ error: 'session is not restartable' });
    }
    return manager.restart(id);
  });

  app.post('/api/sessions/:id/focus', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'external') return reply.code(400).send({ error: 'only external sessions can be focused' });
    if (!ctx.terminals) return reply.code(503).send({ error: 'terminal adapters are unavailable' });
    try {
      await ctx.terminals.focus(session);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(error instanceof AutomationDeniedError ? 403 : 400).send({ error: message });
    }
  });
}
