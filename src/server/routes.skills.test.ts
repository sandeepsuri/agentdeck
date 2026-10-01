import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import type { SessionManager } from '../sessions/manager.js';
import { SkillCatalog } from '../sessions/skill-catalog.js';
import type { Session } from '../types.js';
import { TOKEN_HEADER } from './connection-trust.js';
import { registerRoutes } from './routes.js';

const base = { origin: 'managed', startedAt: '2026-09-28T20:00:00.000Z', lastActivityAt: '2026-09-28T20:00:00.000Z', status: 'working', statusSource: 'hook' } as const;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function build(token?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-skills-route-'));
  dirs.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, 'skills', 'implement'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'implement', 'SKILL.md'), '---\ndescription: Build a ticket\n---\n');
  fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'ship.md'), 'Ship it');
  const sessions: Session[] = [
    { ...base, id: 'claude-1', agent: 'claude', cwd: project },
    { ...base, id: 'codex-1', agent: 'codex', cwd: project },
  ];
  const app = Fastify();
  registerRoutes(app, {
    manager: { getSession: (id: string) => sessions.find((session) => session.id === id) } as unknown as SessionManager,
    config: { ...defaultConfig({}), ...(token ? { tailscaleToken: token } : {}) },
    skills: new SkillCatalog({ claudeHome: home }),
    remoteHosts: ['my-mac.tailnet-1234.ts.net'],
  });
  return app;
}

describe('GET /api/sessions/:id/skills', () => {
  it('lists the project and user skills for a Claude session', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/api/sessions/claude-1/skills' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skills: [
      { name: 'implement', description: 'Build a ticket', source: 'user', kind: 'skill' },
      { name: 'ship', description: 'Ship it', source: 'project', kind: 'command' },
    ] });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/codex-1/skills' })).json()).toEqual({ skills: [] });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/skills' })).statusCode).toBe(404);
    await app.close();
  });

  it('is refused on a remote connection, even with the shared token', async () => {
    const token = 'a-real-remote-access-token-0123456789';
    const app = build(token);
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/claude-1/skills',
      headers: { host: 'my-mac.tailnet-1234.ts.net:4040', [TOKEN_HEADER]: token },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
