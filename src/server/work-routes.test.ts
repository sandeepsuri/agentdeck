import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { createFakeCodexAppServer } from '../test-fixtures/codex-attempt.js';
import { stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { Store } from '../store/index.js';
import { DurableWorkEngine } from '../work-engine/engine.js';
import { createCodexAttemptAdapter } from '../work-engine/runtimes/codex.js';
import type { WorkSpec } from '../work-engine/types.js';
import { registerWorkRoutes } from './work-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
const stores: Store[] = [];
const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-work-routes-'));
  tempDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real repository, never the caller's real ~/.agentdeck/runs, so prepare() has something to resolve against. */
function makeApp(runtimeAdapters?: ConstructorParameters<typeof DurableWorkEngine>[3]) {
  const root = tempDir();
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init');
  git(repoPath, 'config', 'user.email', 'agentdeck@example.test');
  git(repoPath, 'config', 'user.name', 'AgentDeck Test');
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'fixture');
  git(repoPath, 'branch', '-M', 'main');

  const app = Fastify();
  const store = new Store(':memory:');
  store.upsertRepo({ id: repoPath, name: 'example', path: repoPath });
  const engine = runtimeAdapters
    ? new DurableWorkEngine(store, path.join(root, 'runs'), stubRuntimeReadinessSource(), runtimeAdapters)
    : new DurableWorkEngine(store, path.join(root, 'runs'), stubRuntimeReadinessSource());
  registerWorkRoutes(app, engine);
  apps.push(app);
  stores.push(store);
  return { app, repoPath, store };
}

function submittedIntent(repoPath: string, requestedBaseReference = 'feature/exact-request'): WorkSpec {
  return {
    objective: 'Keep a run across restart',
    acceptanceCriteria: ['The run keeps its identity', 'The intent is unchanged'],
    repository: { id: repoPath, name: 'example', path: repoPath },
    requestedBaseReference,
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 900_000, maxModelTurns: 25 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'local-commit',
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('work routes', () => {
  it('submits and retrieves a queued run through the Work Engine', async () => {
    const { app, repoPath } = makeApp();
    const submitted = submittedIntent(repoPath);

    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: submitted,
    });

    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run).toMatchObject({ status: 'queued', spec: submitted });

    const reopened = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toEqual(run);

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listed.json()).toEqual([run]);
  });

  it('reports invalid intent and unknown run identities precisely', async () => {
    const { app, repoPath } = makeApp();
    const invalid = submittedIntent(repoPath);
    invalid.objective = '   ';

    const rejected = await app.inject({ method: 'POST', url: '/api/runs', payload: invalid });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: 'objective must be a non-empty string' });

    const missing = await app.inject({ method: 'GET', url: '/api/runs/unknown' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no such run' });
  });
});

describe('run preparation routes', () => {
  it('prepares a queued run, reporting its resolved base commit and worktree', async () => {
    const { app, repoPath } = makeApp();
    const headSha = git(repoPath, 'rev-parse', 'HEAD');
    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main'),
    });
    const run = created.json();

    const prepared = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });

    expect(prepared.statusCode).toBe(200);
    const body = prepared.json();
    expect(body.status).toBe('preparing');
    expect(body.preparation).toMatchObject({ state: 'ready', baseCommit: headSha });
    expect(fs.existsSync(body.preparation.worktreePath)).toBe(true);
    expect(body.envelope).toMatchObject({
      state: 'ready',
      capabilityEnvelope: { runtime: 'codex', profile: { writableWorktree: body.preparation.worktreePath } },
    });
  });

  it('reports an unknown run and a Git failure precisely', async () => {
    const { app, repoPath } = makeApp();

    const missing = await app.inject({ method: 'POST', url: '/api/runs/unknown/prepare' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no such run: unknown' });

    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'refs/heads/does-not-exist'),
    });
    const run = created.json();

    const prepared = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    expect(prepared.statusCode).toBe(400);
    expect(prepared.json().error).toMatch(/does not exist locally/);
  });

  it('cancels a run without deleting a worktree it already prepared', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main'),
    });
    const run = created.json();
    const prepared = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` })).json();

    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', preparation: prepared.preparation });
    expect(fs.existsSync(prepared.preparation.worktreePath)).toBe(true);
  });
});

describe('run Attempt start route', () => {
  it('reports an unknown run and a not-yet-eligible run precisely', async () => {
    const { app, repoPath } = makeApp();

    const missing = await app.inject({ method: 'POST', url: '/api/runs/unknown/start' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no such run: unknown' });

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    const tooSoon = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    expect(tooSoon.statusCode).toBe(400);
    expect(tooSoon.json().error).toMatch(/prepared/);
  });

  it('starts a Codex Attempt for a prepared, enveloped run and reports its structured progress to completion', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });

    const started = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'running', attempt: { state: 'running', runtime: 'codex' } });

    await vi.waitUntil(async () => {
      const polled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'completed';
    });
    const settled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(settled.json()).toMatchObject({ status: 'completed', attempt: { state: 'completed', runtime: 'codex' } });
  });

  it('refuses to start a second Attempt for the same Run', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });

    const secondStart = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });

    expect(secondStart.statusCode).toBe(400);
    expect(secondStart.json().error).toMatch(/already been started/);

    await vi.waitUntil(async () => {
      const polled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'completed';
    });
  });
});
