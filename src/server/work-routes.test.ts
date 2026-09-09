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
import { buildAttemptEventEnvelope } from '../work-engine/durable-events.js';
import { DurableWorkEngine } from '../work-engine/engine.js';
import { createCodexAttemptAdapter } from '../work-engine/runtimes/codex.js';
import type { Profile, RunActor, WorkSpec } from '../work-engine/types.js';
import type { VerificationGateRunner } from '../work-engine/verification.js';
import { registerWorkRoutes, type RunPreviewStarter, type WorkRoutesDeps } from './work-routes.js';

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
function makeApp(
  runtimeAdapters?: ConstructorParameters<typeof DurableWorkEngine>[3],
  deps?: WorkRoutesDeps | ((repositoryId: string) => WorkRoutesDeps),
) {
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
  // These tests are about the REST surface, not verification (ticket 08) —
  // an explicit no-verification declaration keeps a successful Attempt
  // reaching 'completed_unverified' instead of the 'failed_verification' a
  // Repository with no approved policy at all would now correctly produce.
  store.setRepositoryVerificationPolicy(repoPath, { kind: 'no-verification' });
  const engine = runtimeAdapters
    ? new DurableWorkEngine(store, path.join(root, 'runs'), stubRuntimeReadinessSource(), runtimeAdapters)
    : new DurableWorkEngine(store, path.join(root, 'runs'), stubRuntimeReadinessSource());
  // B07: wired by default, matching server/index.ts's own production
  // wiring — a test that supplies its own deps still gets feedback storage
  // unless it deliberately overrides `runFeedbackStore` itself.
  const resolvedDeps = typeof deps === 'function' ? deps(repoPath) : deps;
  registerWorkRoutes(app, engine, { runFeedbackStore: store, ...resolvedDeps });
  apps.push(app);
  stores.push(store);
  return { app, repoPath, store, engine };
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

/** A named collaborator read without turning this suite's admin fixture submissions into collaborator submissions. */
function collaboratorReadDeps(repositoryIds: readonly string[]): WorkRoutesDeps {
  return {
    resolveGrantedRepositoryIds: () => repositoryIds,
    resolveActor: (request) => request.method === 'GET' ? {
      principal: { id: 'collab-reader', displayName: 'Alice' },
      grants: { repositoryIds, profileIds: [] },
    } : undefined,
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

  it('GET /api/runs/:id/activity reports the durable activity trail for admin observability (ticket 12 AC5)', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const activity = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/activity` });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toEqual([{
      id: expect.any(String), runId: run.id, kind: 'submitted', at: expect.any(String),
      principal: expect.any(Object),
    }]);

    const missing = await app.inject({ method: 'GET', url: '/api/runs/unknown/activity' });
    expect(missing.statusCode).toBe(404);
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

describe('collaborator grant scoping (ticket 11 AC4)', () => {
  it('omits an ungranted Run from the list and 404s reading it by id directly', async () => {
    const { app, repoPath } = makeApp(undefined, collaboratorReadDeps([]));
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listed.json()).toEqual([]);

    const fetched = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(fetched.statusCode).toBe(404);
  });

  it('includes a Run whose Repository id is in the resolved grant set', async () => {
    const { app, repoPath } = makeApp(undefined, (repositoryId) => collaboratorReadDeps([repositoryId]));
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect((listed.json() as { id: string }[]).map((item) => item.id)).toEqual([run.id]);

    const fetched = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(fetched.statusCode).toBe(200);
  });

  // The projection itself is unit-tested in collaborator-run-view.test.ts.
  // These two only pin down that this route applies it, and applies it on
  // exactly the same condition it filters on -- so a caller can never end up
  // filtered but not narrowed, or narrowed but not filtered.
  it('narrows every listed Run to the collaborator projection whenever grants resolved', async () => {
    const { app, repoPath } = makeApp(undefined, (repositoryId) => collaboratorReadDeps([repositoryId]));
    await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    const [item] = listed.json() as { repository: { id: string; name: string }; spec?: unknown }[];
    // This fixture's Repository id happens to BE its path, so "no path
    // crosses out" is asserted in collaborator-run-view.test.ts, where id
    // and path differ. Here the point is only that the projection replaced
    // the raw WorkRun: no spec, no envelope, no verificationPolicy.
    expect(item!.repository).toEqual({ id: repoPath, name: 'example' });
    expect(item!.spec).toBeUndefined();
  });

  it('narrows a Run read by id to the collaborator detail projection, and leaves it raw when no grants resolved', async () => {
    const { app, repoPath } = makeApp(undefined, (repositoryId) => collaboratorReadDeps([repositoryId]));
    const run = (await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) })).json();

    const scoped = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    const detail = scoped.json() as { narrative?: unknown; envelope?: unknown; verificationPolicy?: unknown };
    expect(detail.narrative).toBeDefined();
    expect(detail.envelope).toBeUndefined();
    expect(detail.verificationPolicy).toBeUndefined();

    const { app: adminApp, repoPath: adminRepo } = makeApp(undefined, { resolveGrantedRepositoryIds: () => undefined });
    const adminRun = (await adminApp.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(adminRepo) })).json();
    const raw = (await adminApp.inject({ method: 'GET', url: `/api/runs/${adminRun.id}` })).json() as { spec: { repository: { path: string } } };
    expect(raw.spec.repository.path).toBe(adminRepo);
    expect(raw).not.toHaveProperty('isRequestedByMe');
  });

  it('404s a granted-elsewhere Run read by id -- never leaking that it exists', async () => {
    const { app, repoPath } = makeApp(undefined, collaboratorReadDeps(['some-other-repo']));
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const fetched = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(fetched.statusCode).toBe(404);
    expect(fetched.json()).toEqual({ error: 'no such run' });

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listed.json()).toEqual([]);
  });

  it('stays unrestricted when the resolver returns undefined (local/legacy-token connections)', async () => {
    const { app, repoPath } = makeApp(undefined, { resolveGrantedRepositoryIds: () => undefined });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listed.json()).toEqual([run]);
  });
});

describe('collaborator submit and guide (ticket 12)', () => {
  const collaboratorActor: RunActor = {
    principal: { id: 'collab-1', displayName: 'Alice' },
    device: { id: 'device-1', label: "Alice's phone" },
    grants: { repositoryIds: [], profileIds: ['profile-1'] }, // repositoryIds filled in per-test once repoPath is known
  };

  function actorFor(repoPath: string): RunActor {
    return { ...collaboratorActor, grants: { repositoryIds: [repoPath], profileIds: ['profile-1'] } };
  }

  const approvedProfile: Profile = {
    id: 'profile-1',
    name: 'Standard Codex run',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 900_000, maxModelTurns: 25 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'local-commit',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('submits a Run as the resolved collaborator actor, deriving its spec from the granted Profile', async () => {
    const { app, repoPath, store } = makeApp(undefined, { resolveActor: () => actorFor(repoPath) });
    store.createProfile(approvedProfile);
    const spec = { ...submittedIntent(repoPath), profileId: approvedProfile.id };

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: spec });

    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run.principal).toEqual({ id: 'collab-1', displayName: 'Alice' });
    expect(run.spec.runtimePreference).toEqual(['codex']);
  });

  it('403s a submit for an ungranted Repository, naming the policy rule', async () => {
    const { app, repoPath, store } = makeApp(undefined, { resolveActor: () => collaboratorActor }); // no repositoryIds granted
    store.createProfile(approvedProfile);
    const spec = { ...submittedIntent(repoPath), profileId: approvedProfile.id };

    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: spec });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: expect.any(String), rule: 'repository-not-granted' });
  });

  it('a granted collaborator can prepare, start, and cancel their own Run through REST', async () => {
    const { app, repoPath, store } = makeApp(undefined, { resolveActor: () => actorFor(repoPath) });
    store.createProfile(approvedProfile);
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...submittedIntent(repoPath, 'main'), profileId: approvedProfile.id } });
    const run = created.json();

    const prepared = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    expect(prepared.statusCode).toBe(200);

    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('403s prepare/cancel for a Run outside this actor\'s grants, leaving it queued', async () => {
    const { app, repoPath, store, engine } = makeApp(undefined, { resolveActor: () => actorFor(repoPath) });
    store.createProfile(approvedProfile);
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...submittedIntent(repoPath, 'main'), profileId: approvedProfile.id } });
    const run = created.json();

    // A second app registered against the SAME engine/store, resolving to
    // an actor with no grants at all — same Run, a different requester.
    const outsideApp = Fastify();
    const outsideActor: RunActor = { principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } };
    registerWorkRoutes(outsideApp, engine, { resolveActor: () => outsideActor });
    apps.push(outsideApp);

    const prepared = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    expect(prepared.statusCode).toBe(403);
    expect(prepared.json()).toEqual({ error: expect.any(String), rule: 'repository-not-granted' });

    const cancelled = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(cancelled.statusCode).toBe(403);

    expect(engine.get(run.id)?.status).toBe('queued'); // untouched by either denied attempt
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
      return polled.json().status === 'completed_unverified';
    });
    const settled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(settled.json()).toMatchObject({ status: 'completed_unverified', attempt: { state: 'completed', runtime: 'codex' } });
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
      return polled.json().status === 'completed_unverified';
    });
  });
});

// Ticket 68 (B12, docs/specs/run-retry-attempt-history.md): a genuinely
// new Attempt — a separate resource from /start, never overloading it.
describe('run Attempt retry route (ticket 68, B12)', () => {
  it('reports an unknown run and a not-yet-eligible run precisely', async () => {
    const { app, repoPath } = makeApp();

    const missing = await app.inject({ method: 'POST', url: '/api/runs/unknown/attempts' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no such run: unknown' });

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    const tooSoon = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/attempts` });
    expect(tooSoon.statusCode).toBe(400);
    expect(tooSoon.json().error).toMatch(/status: queued/);
  });

  it('starts a second Attempt for a failed Run, and the Run\'s history shows both', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'turn-failure' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    await vi.waitUntil(async () => {
      const polled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'failed';
    });

    const retried = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/attempts` });

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'running' });
    expect(retried.json().attempts).toHaveLength(2);
    expect(retried.json().attempts[0]).toMatchObject({ ordinal: 1, state: { state: 'failed' } });
    expect(retried.json().attempts[1]).toMatchObject({ ordinal: 2, state: { state: 'running' } });

    const activity = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/activity` });
    expect(activity.json().at(-1)).toMatchObject({ kind: 'attempt-retried' });

    await vi.waitUntil(async () => {
      const polled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'failed' && polled.json().attempts.length === 2;
    });
  });

  it('403s a collaborator actor retrying a Run outside their grants, leaving it untouched', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'turn-failure' });
    const { app, repoPath, store, engine } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    await vi.waitUntil(async () => (await (await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).json()).status === 'failed');

    const outsideApp = Fastify();
    const outsideActor: RunActor = { principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } };
    registerWorkRoutes(outsideApp, engine, { runFeedbackStore: store, resolveActor: () => outsideActor });
    apps.push(outsideApp);

    const response = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/attempts` });
    expect(response.statusCode).toBe(403);
    expect(engine.get(run.id)?.attempts).toHaveLength(1);
  });
});

describe('run pause/resume routes (ticket 54, B11)', () => {
  /**
   * An engine wired to a caller-controlled VerificationGateRunner, so a test
   * can pause a Run from inside a gate call — the exact "safe boundary"
   * DurableWorkEngine.runVerification checks between gates (engine.ts) —
   * and observe the effect purely through this REST surface. Shared by the
   * round-trip and cancel-while-paused tests below rather than duplicated,
   * since both need the identical repo/engine/app wiring.
   */
  function setUpPausableApp(gateRunner: VerificationGateRunner) {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
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

    const store = new Store(':memory:');
    store.upsertRepo({ id: repoPath, name: 'example', path: repoPath });
    store.setRepositoryVerificationPolicy(repoPath, { kind: 'required', gates: [{ name: 'tests', command: 'npm test' }] });
    const engine = new DurableWorkEngine(
      store,
      path.join(root, 'runs'),
      stubRuntimeReadinessSource(),
      { codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) },
      gateRunner,
    );
    const app = Fastify();
    registerWorkRoutes(app, engine);
    apps.push(app);
    stores.push(store);
    return { app, repoPath };
  }

  async function startPausable(app: ReturnType<typeof Fastify>, repoPath: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ...submittedIntent(repoPath, 'main'), verificationIntent: { required: false, commands: [] } },
    });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    const started = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    expect(started.statusCode).toBe(200);
    return run;
  }


  it('404s pausing/resuming an unknown run, and 400s pausing a run with no live Attempt or resuming one never paused', async () => {
    const { app, repoPath } = makeApp();

    const missingPause = await app.inject({ method: 'POST', url: '/api/runs/unknown/pause' });
    expect(missingPause.statusCode).toBe(404);
    expect(missingPause.json()).toEqual({ error: 'no such run: unknown' });
    const missingResume = await app.inject({ method: 'POST', url: '/api/runs/unknown/resume' });
    expect(missingResume.statusCode).toBe(404);
    expect(missingResume.json()).toEqual({ error: 'no such run: unknown' });

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json(); // freshly submitted — queued, no live Attempt in this process

    const pause = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/pause` });
    expect(pause.statusCode).toBe(400);

    const resume = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/resume` });
    expect(resume.statusCode).toBe(400);
  });

  it('403s a collaborator actor pausing/resuming a Run outside their grants, leaving it untouched', async () => {
    const { app, repoPath, engine } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();

    const outsideApp = Fastify();
    const outsideActor: RunActor = { principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } };
    registerWorkRoutes(outsideApp, engine, { resolveActor: () => outsideActor });
    apps.push(outsideApp);

    const pause = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/pause` });
    expect(pause.statusCode).toBe(403);
    const resume = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/resume` });
    expect(resume.statusCode).toBe(403);
    expect(engine.get(run.id)?.status).toBe('queued');
  });

  it('pauses a running Attempt at its next safe boundary and resumes it to completion, entirely through REST — repeated pause is a no-op, never an error (B11 AC3)', async () => {
    let runId: string | undefined;
    let app: ReturnType<typeof Fastify> | undefined;
    let gateCalls = 0;
    const gateRunner: VerificationGateRunner = async () => {
      gateCalls += 1;
      if (gateCalls === 1 && runId && app) {
        const paused = await app.inject({ method: 'POST', url: `/api/runs/${runId}/pause` });
        expect(paused.statusCode).toBe(200);
        expect(paused.json().status).toBe('pause_requested');
      }
      return gateCalls === 1
        ? { passed: false, exitCode: 1, evidence: 'not fixed yet' }
        : { passed: true, exitCode: 0, evidence: 'ok' };
    };
    const setup = setUpPausableApp(gateRunner);
    app = setup.app;
    const run = await startPausable(app, setup.repoPath);
    runId = run.id;

    await vi.waitUntil(async () => {
      const polled = await app!.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'paused';
    }, { timeout: 20_000 });

    const repeated = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/pause` });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().status).toBe('paused');

    const resumed = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).not.toBe('paused');
    expect(resumed.json().status).not.toBe('pause_requested');

    await vi.waitUntil(async () => {
      const polled = await app!.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'completed';
    }, { timeout: 20_000 });
    expect(gateCalls).toBe(2);
  });

  it('lets a REST cancel end a paused Attempt through this same transport, rather than leaving it hanging for a resume that never comes (B11 AC3: cancellation during the request)', async () => {
    let runId: string | undefined;
    let app: ReturnType<typeof Fastify> | undefined;
    let gateCalls = 0;
    const gateRunner: VerificationGateRunner = async () => {
      gateCalls += 1;
      if (gateCalls === 1 && runId && app) await app.inject({ method: 'POST', url: `/api/runs/${runId}/pause` });
      return { passed: false, exitCode: 1, evidence: 'still broken' };
    };
    const setup = setUpPausableApp(gateRunner);
    app = setup.app;
    const run = await startPausable(app, setup.repoPath);
    runId = run.id;

    await vi.waitUntil(async () => {
      const polled = await app!.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().status === 'paused';
    }, { timeout: 20_000 });

    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    // Never resumed — cancel alone ended a paused Attempt through REST.
    expect(gateCalls).toBe(1);
  });
});

describe('run attention routes (ticket 07)', () => {
  async function startWithAttentionRequest(app: ReturnType<typeof Fastify>, repoPath: string) {
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    await vi.waitUntil(async () => {
      const polled = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
      return polled.json().pendingAttention !== undefined;
    });
    return run.id as string;
  }

  it('GET /api/runs/attention lists only the objective, reason, and correlation for a pending request — never the Repository, budget, or spec', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request', attentionParams: { command: 'rm -rf node_modules' } });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);

    const listed = await app.inject({ method: 'GET', url: '/api/runs/attention' });

    expect(listed.statusCode).toBe(200);
    const items = listed.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      runId, kind: 'approval', reason: expect.stringContaining('rm -rf node_modules'), objective: 'Keep a run across restart',
    });
    expect(Object.keys(items[0]).sort()).toEqual(['attentionId', 'kind', 'objective', 'reason', 'requestedAt', 'runId']);
    expect(JSON.stringify(items)).not.toContain(repoPath);
  });

  it('ticket 12 AC3: a collaborator device sees its own granted Run\'s pending attention, and none outside its grants', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const granted = makeApp(
      { codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) },
    );
    const runId = await startWithAttentionRequest(granted.app, granted.repoPath);

    // Same Run, re-registered against the same engine with a resolver
    // granting its Repository — proves the filter *includes* a granted Run.
    const grantedRoutesApp = Fastify();
    registerWorkRoutes(grantedRoutesApp, granted.engine, collaboratorReadDeps([granted.repoPath]));
    apps.push(grantedRoutesApp);
    const asGranted = await grantedRoutesApp.inject({ method: 'GET', url: '/api/runs/attention' });
    expect(asGranted.json()).toHaveLength(1);
    expect(asGranted.json()[0]).toMatchObject({ runId });

    // And with nothing granted at all — proves the filter *excludes* it,
    // never falling back to the unfiltered system-wide queue.
    const ungrantedRoutesApp = Fastify();
    registerWorkRoutes(ungrantedRoutesApp, granted.engine, collaboratorReadDeps([]));
    apps.push(ungrantedRoutesApp);
    const asUngranted = await ungrantedRoutesApp.inject({ method: 'GET', url: '/api/runs/attention' });
    expect(asUngranted.json()).toEqual([]);
  });

  it('approves a pending request through POST .../attention/:attentionId/approve, resuming the Attempt to completion', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);
    const attentionId = (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).pendingAttention.id;

    const approved = await app.inject({ method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/approve` });

    expect(approved.statusCode).toBe(200);
    expect(approved.json().pendingAttention).toBeUndefined();
    await vi.waitUntil(async () => (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).status === 'completed_unverified');
  });

  it('denies a pending request through .../deny, and reports an already-resolved request precisely on a repeat call', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);
    const attentionId = (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).pendingAttention.id;

    const denied = await app.inject({ method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/deny` });
    expect(denied.statusCode).toBe(200);

    const repeat = await app.inject({ method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/deny` });
    expect(repeat.statusCode).toBe(404);
    expect(repeat.json().error).toMatch(/no pending attention request/);

    // Denial resumes the Attempt (this fixture finishes its script exactly
    // like an approval) rather than ending it outright — let it fully settle
    // before this test's own afterEach tears down the worktree and store out
    // from under whatever verification/delivery work is still in flight.
    await vi.waitUntil(async () => (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).status === 'completed_unverified');
  });

  it('provides clarifying input through .../input, requiring a non-empty value', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request', attentionMethod: 'thread/requestClarification' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);
    const attentionId = (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).pendingAttention.id;

    const missingValue = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/input`,
      headers: { 'content-type': 'application/json' }, payload: {},
    });
    expect(missingValue.statusCode).toBe(400);

    const provided = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/input`,
      headers: { 'content-type': 'application/json' }, payload: { value: 'Use TypeScript strict mode.' },
    });
    expect(provided.statusCode).toBe(200);
    await vi.waitUntil(async () => (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).status === 'completed_unverified');
  });

  it('refuses to resolve an approval-kind request with input, reporting 400', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);
    const attentionId = (await (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).pendingAttention.id;

    const response = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/attention/${attentionId}/input`,
      headers: { 'content-type': 'application/json' }, payload: { value: 'nope' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/cannot be resolved by providing input/);
  });

  it('reports a mismatched attentionId and an unknown run precisely', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const runId = await startWithAttentionRequest(app, repoPath);

    const wrongAttention = await app.inject({ method: 'POST', url: `/api/runs/${runId}/attention/not-the-real-id/approve` });
    expect(wrongAttention.statusCode).toBe(404);

    const unknownRun = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/attention/any-id/approve' });
    expect(unknownRun.statusCode).toBe(404);
    expect(unknownRun.json()).toEqual({ error: 'no such run: does-not-exist' });
  });
});

describe('run publish route (ticket 13)', () => {
  const collaboratorActor: RunActor = {
    principal: { id: 'collab-1', displayName: 'Alice' },
    device: { id: 'device-1', label: "Alice's phone" },
    grants: { repositoryIds: [], profileIds: [] },
  };

  it('refuses a collaborator device with the policy rule, before the Run state is even inspected (AC2: collaborator refusal over REST)', async () => {
    const { app, repoPath, engine } = makeApp(undefined, { resolveActor: () => collaboratorActor });
    // Submitted by the admin (no actor) — a queued Run the admin would get a
    // 400 "not eligible" for; the collaborator gets the policy 403 first.
    const run = await engine.submit(submittedIntent(repoPath, 'main'));

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/publish` });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: expect.stringContaining('admin'), rule: 'publish-admin-only' });
    expect(engine.get(run.id)?.publication).toBeUndefined();
  });

  it('returns 404 for an unknown Run and 400 for a malformed target or an ineligible Run', async () => {
    const { app, repoPath } = makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/runs/unknown-run/publish' })).statusCode).toBe(404);

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json() as { id: string };
    const malformed = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/publish`, payload: { target: 'force-push' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'target must be push or draft-pull-request' });

    const queued = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/publish` });
    expect(queued.statusCode).toBe(400);
    expect(queued.json()).toEqual({ error: expect.stringContaining('verified, completed Run') });
  });
});

describe('DELETE /api/runs/:id', () => {
  it('permanently deletes a Run once it has reached a terminal status', async () => {
    const { app, repoPath, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();
    store.updateRun({ ...run, status: 'completed' });

    const response = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}` });
    expect(response.statusCode).toBe(204);

    const reopened = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(reopened.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).json()).toEqual([]);
  });

  it('refuses to delete a Run that is still in progress, leaving it untouched', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json(); // fresh submit() is 'queued' — never terminal

    const response = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}` });
    expect(response.statusCode).toBe(400);

    const reopened = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(reopened.statusCode).toBe(200);
  });

  it('404s for an unknown Run', async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/runs/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a collaborator actor with the policy rule, never deleting the Run (admin-only, exactly like publish)', async () => {
    const { app, repoPath, store, engine } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();
    store.updateRun({ ...run, status: 'completed' });

    const collaboratorApp = Fastify();
    const collaboratorActor: RunActor = {
      principal: { id: 'collab-1', displayName: 'Alice' },
      grants: { repositoryIds: [repoPath], profileIds: [] },
    };
    registerWorkRoutes(collaboratorApp, engine, { resolveActor: () => collaboratorActor });
    apps.push(collaboratorApp);

    const response = await collaboratorApp.inject({ method: 'DELETE', url: `/api/runs/${run.id}` });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: expect.stringContaining('admin'), rule: 'delete-admin-only' });
    expect(engine.get(run.id)).toBeDefined();
  });
});

// B07 (docs/specs/run-feedback-review.md, ticket #67): durable, plain-text
// Task/Run commentary — its own describe block since it is a genuinely
// separate feature from Run lifecycle above, sharing only the Run/grant
// fixtures.
describe('Run feedback (B07)', () => {
  function feedbackCollaboratorDeps(
    repositoryIds: readonly string[],
    principal: { id: string; displayName: string } = { id: 'collab-reader', displayName: 'Alice' },
  ): WorkRoutesDeps {
    return {
      resolveGrantedRepositoryIds: () => repositoryIds,
      resolveActor: () => ({ principal, grants: { repositoryIds, profileIds: [] } }),
      resolveAuthor: () => ({ principalId: principal.id, displayName: principal.displayName }),
    };
  }

  it('posts and lists feedback for an admin, attributed to the local operator', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const posted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'Should this touch auth too?' } });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({
      taskId: run.taskId, runId: run.id, sequence: 1, text: 'Should this touch auth too?',
    });
    expect(posted.json().displayName).toEqual(expect.any(String));

    const listed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([posted.json()]);
  });

  it('assigns a monotonic sequence and returns entries oldest-first', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'first' } });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'second' } });

    const listed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.json().map((entry: { text: string }) => entry.text)).toEqual(['first', 'second']);
  });

  it('400s empty text without creating an entry', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: '   ' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'text is required' });
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.json()).toEqual([]);
  });

  it('404s GET and POST for an unknown Run', async () => {
    const { app } = makeApp();

    const listed = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist/feedback' });
    expect(listed.statusCode).toBe(404);

    const posted = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/feedback', payload: { text: 'hi' } });
    expect(posted.statusCode).toBe(404);
  });

  it('is readable/postable for a Run in a terminal failure status — feedback never assumes a live process', async () => {
    const { app, repoPath, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();
    store.updateRun({ ...run, status: 'failed' });

    const posted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'why did this fail?' } });
    expect(posted.statusCode).toBe(201);

    const listed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.json()).toHaveLength(1);
  });

  it('a granted collaborator can read and post feedback, attributed to their own Principal', async () => {
    const { app, repoPath, engine, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const collaboratorApp = Fastify();
    registerWorkRoutes(collaboratorApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([repoPath]) });
    apps.push(collaboratorApp);

    const posted = await collaboratorApp.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'looks good' } });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ principalId: 'collab-reader', displayName: 'Alice', text: 'looks good' });

    const listed = await collaboratorApp.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.json()).toEqual([posted.json()]);
  });

  it('404s (never 403) GET and POST feedback for a collaborator outside the Run\'s grant, never leaking existence', async () => {
    const { app, repoPath, engine, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const outsideApp = Fastify();
    registerWorkRoutes(outsideApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([]) });
    apps.push(outsideApp);

    const listed = await outsideApp.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.statusCode).toBe(404);
    expect(listed.json()).toEqual({ error: 'no such run' });

    const posted = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'hi' } });
    expect(posted.statusCode).toBe(404);
  });

  it('keeps a departed collaborator\'s already-posted feedback durable and visible to the admin after their grant is revoked', async () => {
    const { app, repoPath, engine, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const collaboratorApp = Fastify();
    registerWorkRoutes(collaboratorApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([repoPath]) });
    apps.push(collaboratorApp);
    await collaboratorApp.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'from a collaborator' } });

    // The admin (unfiltered) read still sees it durably, independent of the
    // collaborator's own subsequent access.
    const adminListed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(adminListed.json()).toHaveLength(1);
    expect(adminListed.json()[0]).toMatchObject({ text: 'from a collaborator' });

    // Revoked: a fresh app resolving zero grants for the same collaborator
    // now 404s, exactly like it would for the Run itself — but the entry
    // above remains, never deleted by the revocation.
    const revokedApp = Fastify();
    registerWorkRoutes(revokedApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([]) });
    apps.push(revokedApp);
    const revokedListed = await revokedApp.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(revokedListed.statusCode).toBe(404);
  });
});

// Ticket 71 (B09, docs/specs/run-feedback-review.md): the review state is
// derived (deriveRunReviewState, work-engine/run-review.ts) — its own
// coverage lives in run-review.test.ts. Here, only the HTTP wiring: the new
// GET .../review route, the reviewDecision passthrough on the existing POST
// .../feedback route, and both routes' shared grant check.
describe('Run review state (ticket 71, B09)', () => {
  function feedbackCollaboratorDeps(
    repositoryIds: readonly string[],
    principal: { id: string; displayName: string } = { id: 'collab-reader', displayName: 'Alice' },
  ): WorkRoutesDeps {
    return {
      resolveGrantedRepositoryIds: () => repositoryIds,
      resolveActor: () => ({ principal, grants: { repositoryIds, profileIds: [] } }),
      resolveAuthor: () => ({ principalId: principal.id, displayName: principal.displayName }),
    };
  }

  it('is not_applicable for a freshly submitted Run with no result and no decision', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const review = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });

    expect(review.statusCode).toBe(200);
    expect(review.json()).toEqual({ state: 'not_applicable' });
  });

  it('is ready_to_review once a Run settles with a result, before any decision is posted', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const { app, repoPath } = makeApp({ codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/start` });
    await vi.waitUntil(async () => (await (await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).json()).status === 'completed_unverified');

    const review = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });

    expect(review.statusCode).toBe(200);
    expect(review.json()).toEqual({ state: 'ready_to_review' });
  });

  it('posting feedback with a reviewDecision durably moves the review state, and wins even before any result exists', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const posted = await app.inject({
      method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'Please add a test', reviewDecision: 'changes_requested' },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ reviewDecision: 'changes_requested' });

    const review = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });
    expect(review.json()).toMatchObject({ state: 'changes_requested' });
    expect(review.json().reviewedBy).toEqual(expect.any(String));
  });

  it('400s an invalid reviewDecision without posting an entry or moving the review state', async () => {
    const { app, repoPath } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const posted = await app.inject({
      method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'hi', reviewDecision: 'approved' },
    });

    expect(posted.statusCode).toBe(400);
    expect(posted.json()).toEqual({ error: 'reviewDecision must be "changes_requested" or "reviewed"' });
    const listed = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/feedback` });
    expect(listed.json()).toEqual([]);
    const review = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });
    expect(review.json()).toEqual({ state: 'not_applicable' });
  });

  it('404s GET .../review for an unknown Run', async () => {
    const { app } = makeApp();

    const review = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist/review' });

    expect(review.statusCode).toBe(404);
  });

  it('a granted collaborator can post a reviewDecision and read the resulting review state', async () => {
    const { app, repoPath, engine, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const collaboratorApp = Fastify();
    registerWorkRoutes(collaboratorApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([repoPath]) });
    apps.push(collaboratorApp);

    const posted = await collaboratorApp.inject({
      method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { text: 'looks good to me', reviewDecision: 'reviewed' },
    });
    expect(posted.statusCode).toBe(201);

    const review = await collaboratorApp.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });
    expect(review.json()).toMatchObject({ state: 'reviewed', reviewedBy: 'Alice' });
  });

  it('404s (never 403) GET .../review for a collaborator outside the Run\'s grant, never leaking existence', async () => {
    const { app, repoPath, engine, store } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath) });
    const run = created.json();

    const outsideApp = Fastify();
    registerWorkRoutes(outsideApp, engine, { runFeedbackStore: store, ...feedbackCollaboratorDeps([]) });
    apps.push(outsideApp);

    const review = await outsideApp.inject({ method: 'GET', url: `/api/runs/${run.id}/review` });
    expect(review.statusCode).toBe(404);
    expect(review.json()).toEqual({ error: 'no such run' });
  });
});

// Ticket 70 (B10, docs/specs/run-result-application-previews.md): the
// route only ever validates the request and hands it to a RunPreviewStarter
// — the real listener (a real http.createServer, real files on disk) is
// exercised on its own in server/run-preview-server.test.ts. Here, a fake
// is enough to prove the route's own validation and grant-scoping.
describe('run preview route (ticket 70, B10)', () => {
  function fakePreviewServer(): RunPreviewStarter & { calls: { runId: string; worktreePath: string; entryPath: string }[] } {
    const calls: { runId: string; worktreePath: string; entryPath: string }[] = [];
    return {
      calls,
      async start(input) {
        calls.push(input);
        return { previewUrl: `http://127.0.0.1:9999/tok/${input.entryPath}`, expiresAt: '2026-01-01T00:00:00.000Z' };
      },
    };
  }

  async function settledRunWithHtml(app: ReturnType<typeof Fastify>, repoPath: string, store: Store) {
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/prepare` });
    store.startAttempt({ id: 'attempt-1', runId: run.id, runtime: 'codex', startedAt: new Date().toISOString() });
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: run.id, attemptId: 'attempt-1',
      event: { kind: 'worktree-changes', sequence: 0, at: new Date().toISOString(), changedFiles: ['dist/index.html', 'src/index.ts'] },
    }));
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: run.id, attemptId: 'attempt-1',
      event: {
        kind: 'verification-outcome', sequence: 1, at: new Date().toISOString(), outcome: 'unverified', repairAttempts: 0,
      },
    }));
    return (await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).json();
  }

  it('starts a preview session for a valid candidate path, scoped to the Run\'s own worktree', async () => {
    const previewServer = fakePreviewServer();
    const { app, repoPath, store } = makeApp(undefined, { runPreviewServer: previewServer });
    const run = await settledRunWithHtml(app, repoPath, store);

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: { path: 'dist/index.html' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ previewUrl: 'http://127.0.0.1:9999/tok/dist/index.html', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(previewServer.calls).toEqual([{ runId: run.id, worktreePath: run.preparation.worktreePath, entryPath: 'dist/index.html' }]);
  });

  it('404s an unknown Run', async () => {
    const { app } = makeApp(undefined, { runPreviewServer: fakePreviewServer() });
    const response = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/preview', payload: { path: 'dist/index.html' } });
    expect(response.statusCode).toBe(404);
  });

  it('400s a missing path', async () => {
    const previewServer = fakePreviewServer();
    const { app, repoPath, store } = makeApp(undefined, { runPreviewServer: previewServer });
    const run = await settledRunWithHtml(app, repoPath, store);

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(previewServer.calls).toHaveLength(0);
  });

  it('400s a path that is not one of this Run\'s own previewable files', async () => {
    const previewServer = fakePreviewServer();
    const { app, repoPath, store } = makeApp(undefined, { runPreviewServer: previewServer });
    const run = await settledRunWithHtml(app, repoPath, store);

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: { path: '../../etc/passwd' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'path is not a previewable file for this Run' });
    expect(previewServer.calls).toHaveLength(0);
  });

  it('400s before the Attempt has settled — no RunResult, so no candidate list yet', async () => {
    const previewServer = fakePreviewServer();
    const { app, repoPath } = makeApp(undefined, { runPreviewServer: previewServer });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: submittedIntent(repoPath, 'main') });
    const run = created.json();

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: { path: 'dist/index.html' } });

    expect(response.statusCode).toBe(400);
    expect(previewServer.calls).toHaveLength(0);
  });

  it('500s honestly when no preview server is configured, rather than silently succeeding', async () => {
    const { app, repoPath, store } = makeApp();
    const run = await settledRunWithHtml(app, repoPath, store);

    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: { path: 'dist/index.html' } });

    expect(response.statusCode).toBe(500);
  });

  it('404s (never 403) a collaborator actor outside the Run\'s grant, never starting a preview session', async () => {
    const previewServer = fakePreviewServer();
    const { app, repoPath, store, engine } = makeApp(undefined, { runPreviewServer: previewServer });
    const run = await settledRunWithHtml(app, repoPath, store);

    const outsideApp = Fastify();
    registerWorkRoutes(outsideApp, engine, {
      runFeedbackStore: store,
      runPreviewServer: previewServer,
      resolveGrantedRepositoryIds: () => [],
      resolveActor: () => ({ principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } }),
    });
    apps.push(outsideApp);

    const response = await outsideApp.inject({ method: 'POST', url: `/api/runs/${run.id}/preview`, payload: { path: 'dist/index.html' } });

    expect(response.statusCode).toBe(404);
    expect(previewServer.calls).toHaveLength(0);
  });
});
