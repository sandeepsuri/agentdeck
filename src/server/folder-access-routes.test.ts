import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type AgentDeckConfig } from '../config.js';
import { Store } from '../store/index.js';
import type { Session } from '../types.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-access-routes-')));
  tempDirs.push(dir);
  return dir;
}
function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
}

let app: ReturnType<typeof Fastify> | undefined;
let store: Store | undefined;
afterEach(async () => {
  await app?.close();
  store?.close();
  app = undefined;
  store = undefined;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function build(config: AgentDeckConfig, options: { pick?: () => Promise<string | undefined>; launched?: Session[] } = {}) {
  const saved: Partial<AgentDeckConfig>[] = [];
  const launched = options.launched ?? [];
  store = new Store(':memory:');
  app = buildApp({
    config,
    store,
    saveConfig: (patch) => saved.push(patch),
    ...(options.pick ? { pickAccessFolder: options.pick } : {}),
    manager: {
      launch: async (spec: { cwd: string }) => {
        const session = { id: 's1', agent: 'claude', cwd: spec.cwd, status: 'running', startedAt: '2026-09-27T00:00:00.000Z' } as unknown as Session;
        launched.push(session);
        return session;
      },
      listSessions: () => launched,
      getSession: () => undefined,
    } as unknown as RouteContext['manager'],
  });
  return { saved, launched };
}

describe('Settings → Folder access', () => {
  it('lists nothing and refuses launches when the Mac app started it with no folder chosen', async () => {
    const outside = tempDir();
    build({ ...defaultConfig({}), projectsDir: '', launchedByApp: true });

    const settings = await app!.inject({ method: 'GET', url: '/api/settings/access' });
    expect(settings.json()).toMatchObject({ roots: [], chosen: false, enforced: true, launchedByApp: true });
    expect((await app!.inject({ method: 'GET', url: '/api/repos' })).json()).toEqual([]);

    const launch = await app!.inject({ method: 'POST', url: '/api/sessions', payload: { agent: 'claude', cwd: outside } });
    expect(launch.statusCode).toBe(403);
    expect(launch.json()).toMatchObject({ code: 'folder-access' });
  });

  it('saves chosen folders, scans only them, and allows launches inside them only', async () => {
    const home = tempDir();
    const projects = path.join(home, 'Projects');
    const other = path.join(home, 'Other');
    initRepo(path.join(projects, 'alpha'));
    initRepo(path.join(other, 'hidden'));
    const config = { ...defaultConfig({}), projectsDir: '', launchedByApp: true };
    const { saved } = build(config);

    const put = await app!.inject({ method: 'PUT', url: '/api/settings/access', payload: { roots: [projects] } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ chosen: true, roots: [{ path: projects, exists: true }] });
    expect(saved).toEqual([{ allowedRoots: [projects] }]);

    const repos = (await app!.inject({ method: 'GET', url: '/api/repos' })).json() as { name: string }[];
    expect(repos.map((repo) => repo.name)).toEqual(['alpha']);

    const inside = await app!.inject({ method: 'POST', url: '/api/sessions', payload: { agent: 'claude', cwd: path.join(projects, 'alpha') } });
    expect(inside.statusCode).toBe(201);
    const outside = await app!.inject({ method: 'POST', url: '/api/sessions', payload: { agent: 'claude', cwd: path.join(other, 'hidden') } });
    expect(outside.statusCode).toBe(403);

    const cleared = await app!.inject({ method: 'PUT', url: '/api/settings/access', payload: { roots: [] } });
    expect(cleared.json()).toMatchObject({ chosen: false, roots: [] });
    expect(saved.at(-1)).toEqual({ allowedRoots: undefined });
  });

  it('refuses a folder that is too broad or missing', async () => {
    build({ ...defaultConfig({}), projectsDir: '' });
    const home = await app!.inject({ method: 'PUT', url: '/api/settings/access', payload: { roots: [os.homedir()] } });
    expect(home.statusCode).toBe(400);
    expect(home.json()).toMatchObject({ code: 'too-broad' });
    const missing = await app!.inject({ method: 'PUT', url: '/api/settings/access', payload: { roots: ['/nonexistent/agentdeck'] } });
    expect(missing.json()).toMatchObject({ code: 'not-found' });
    const malformed = await app!.inject({ method: 'PUT', url: '/api/settings/access', payload: { roots: 'nope' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('adds a folder chosen in the native picker, and treats cancel as no change', async () => {
    const projects = path.join(tempDir(), 'Projects');
    fs.mkdirSync(projects);
    let answer: string | undefined = projects;
    const { saved } = build({ ...defaultConfig({}), projectsDir: '' }, { pick: async () => answer });

    const picked = await app!.inject({ method: 'POST', url: '/api/settings/access/pick' });
    expect(picked.json()).toMatchObject({ roots: [{ path: projects }] });
    answer = undefined;
    const cancelled = await app!.inject({ method: 'POST', url: '/api/settings/access/pick' });
    expect(cancelled.json()).toMatchObject({ cancelled: true, roots: [{ path: projects }] });
    expect(saved).toHaveLength(1);
  });

  it('keeps legacy npm start behavior when nothing is chosen outside the Mac app', async () => {
    const anywhere = tempDir();
    build({ ...defaultConfig({}), projectsDir: anywhere });
    expect((await app!.inject({ method: 'GET', url: '/api/settings/access' })).json()).toMatchObject({ enforced: false, roots: [{ path: anywhere }] });
    const launch = await app!.inject({ method: 'POST', url: '/api/sessions', payload: { agent: 'claude', cwd: anywhere } });
    expect(launch.statusCode).toBe(201);
  });

  it('is not reachable from a remote device', async () => {
    const token = 'a-real-remote-access-token-0123456789';
    build({ ...defaultConfig({}), projectsDir: '', tailscaleToken: token });
    const remote = await app!.inject({
      method: 'PUT', url: '/api/settings/access', payload: { roots: [] },
      headers: { host: 'my-mac.tailnet-1234.ts.net:4040', [TOKEN_HEADER]: token },
    });
    expect(remote.statusCode).toBeGreaterThanOrEqual(400);
    expect(remote.statusCode).toBeLessThan(500);
  });
});
