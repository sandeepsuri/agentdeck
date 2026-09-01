import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import type { RuntimeReadinessSource } from '../sessions/runtime-readiness.js';
import { createFakeCodexAppServer } from '../test-fixtures/codex-attempt.js';
import { stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { Store } from '../store/index.js';
import { buildAttemptEventEnvelope } from './durable-events.js';
import { CHILD_RUN_CEILING, TRUSTED_RUNTIME_PROVIDER_DOMAINS } from './envelope.js';
import {
  DurableWorkEngine, InvalidRunStateError, RunAttentionNotPendingError, RunNotFoundError, UnsupportedRuntimeError,
} from './engine.js';
import { runBranchName, runWorktreePath } from './prepare.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import type { RunRepository, WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-work-engine-'));
  tempDirectories.push(directory);
  return directory;
}

function databasePath(): string {
  return path.join(tempDir(), 'agentdeck.db');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'agentdeck@example.test');
  git(dir, 'config', 'user.name', 'AgentDeck Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
  git(dir, 'branch', '-M', 'main');
}

function registerGitRepository(store: Store, repoPath: string): RunRepository {
  const repository: RunRepository = { id: repoPath, name: path.basename(repoPath), path: repoPath };
  store.upsertRepo(repository);
  return repository;
}

function workSpec(): WorkSpec {
  return {
    objective: 'Add durable managed work',
    acceptanceCriteria: [
      'The queued run survives restart',
      'The submitted intent is unchanged',
    ],
    repository: {
      id: '/repos/agentdeck',
      name: 'agentdeck',
      path: '/repos/agentdeck',
    },
    requestedBaseReference: 'refs/heads/main',
    runtimePreference: ['codex', 'claude'],
    budget: {
      maxWallClockMs: 3_600_000,
      maxModelTurns: 40,
      maxToolCalls: 200,
    },
    verificationIntent: {
      required: true,
      commands: ['npm test', 'npm run typecheck'],
    },
    requestedDeliveryResult: 'local-commit',
  };
}

function registerRepository(store: Store): void {
  store.upsertRepo({ id: '/repos/agentdeck', name: 'agentdeck', path: '/repos/agentdeck' });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('DurableWorkEngine', () => {
  it('submits one objective as a durable task and queued run with frozen intent', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();

    const run = await engine.submit(submitted);

    expect(run).toMatchObject({
      taskId: expect.any(String),
      id: expect.any(String),
      status: 'queued',
      spec: submitted,
      submittedAt: expect.any(String),
    });
    expect(engine.get(run.id)).toEqual(run);
    expect(engine.list()).toEqual([run]);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.spec)).toBe(true);
    expect(Object.isFrozen(run.spec.acceptanceCriteria)).toBe(true);

    store.close();
  });

  it('reopens the same queued run and submitted intent after the store restarts', async () => {
    const dbPath = databasePath();
    const firstStore = new Store(dbPath);
    registerRepository(firstStore);
    const submitted = workSpec();
    const created = await new DurableWorkEngine(firstStore).submit(submitted);
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = new DurableWorkEngine(reopenedStore).get(created.id);

    expect(reopened).toEqual(created);
    expect(reopened?.id).toBe(created.id);
    expect(reopened?.taskId).toBe(created.taskId);
    expect(reopened?.status).toBe('queued');
    expect(reopened?.spec).toEqual(submitted);
    reopenedStore.close();
  });

  it('copies submitted values so caller mutation cannot rewrite the frozen run', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();
    const run = await engine.submit(submitted);

    submitted.acceptanceCriteria.push('A later caller mutation');
    submitted.repository.name = 'renamed-after-submit';
    submitted.runtimePreference.reverse();

    expect(engine.get(run.id)?.spec).toEqual(workSpec());
    store.close();
  });

  it('rejects incomplete intent before creating a run', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();
    submitted.acceptanceCriteria = [];

    await expect(engine.submit(submitted)).rejects.toThrow('acceptanceCriteria');
    expect(engine.list()).toEqual([]);
    store.close();
  });

  it('rejects a Repository outside AgentDeck\'s known repository boundary', async () => {
    const store = new Store(':memory:');
    const engine = new DurableWorkEngine(store);

    await expect(engine.submit(workSpec())).rejects.toThrow('repository is not known');
    expect(engine.list()).toEqual([]);
    store.close();
  });
});

describe('DurableWorkEngine.prepare', () => {
  function setUp(runtimeReadiness: RuntimeReadinessSource = stubRuntimeReadinessSource()) {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const store = new Store(':memory:');
    const repository = registerGitRepository(store, repoPath);
    const runsRoot = path.join(root, 'runs');
    const engine = new DurableWorkEngine(store, runsRoot, runtimeReadiness);
    return { root, repoPath, store, repository, runsRoot, engine };
  }

  async function submitRun(engine: DurableWorkEngine, repository: RunRepository, overrides: Partial<WorkSpec> = {}) {
    return engine.submit({ ...workSpec(), repository, requestedBaseReference: 'main', ...overrides });
  }

  it('resolves the exact local base commit with no fetch and creates a dedicated clean worktree', async () => {
    const { repoPath, store, repository, runsRoot, engine } = setUp();
    const headSha = git(repoPath, 'rev-parse', 'HEAD');
    const submitted = await submitRun(engine, repository);

    const prepared = await engine.prepare(submitted.id);

    expect(prepared.status).toBe('preparing');
    expect(prepared.preparation).toEqual({
      state: 'ready',
      baseCommit: headSha,
      worktreePath: runWorktreePath(runsRoot, submitted.id),
      branch: runBranchName(submitted.id),
    });
    expect(fs.existsSync(prepared.preparation.worktreePath!)).toBe(true);
    expect(git(prepared.preparation.worktreePath!, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(engine.get(submitted.id)).toEqual(prepared);
    store.close();
  });

  it('freezes a ready capability envelope pinned to the first eligible preferred runtime once the worktree exists', async () => {
    const { store, repository, runsRoot, engine } = setUp();
    const submitted = await submitRun(engine, repository);

    const prepared = await engine.prepare(submitted.id);

    expect(prepared.envelope).toEqual({
      state: 'ready',
      capabilityEnvelope: {
        runtime: 'codex',
        profile: {
          writableWorktree: runWorktreePath(runsRoot, submitted.id),
          readableRoots: [runWorktreePath(runsRoot, submitted.id)],
          allowedNetworkDomains: TRUSTED_RUNTIME_PROVIDER_DOMAINS.codex,
          environmentAllowlist: expect.any(Array),
          processCeiling: expect.any(Number),
          childRunCeiling: CHILD_RUN_CEILING,
        },
        secretGrants: [],
      },
    });
    store.close();
  });

  it('refuses managed envelope status when no preferred runtime can enforce execution restrictions', async () => {
    const { store, repository, engine } = setUp();
    const submitted = await submitRun(engine, repository, { runtimePreference: ['claude'] });

    const prepared = await engine.prepare(submitted.id);

    expect(prepared.preparation.state).toBe('ready');
    expect(prepared.envelope.state).toBe('refused');
    if (prepared.envelope.state !== 'refused') throw new Error('expected refused');
    expect(prepared.envelope.reason).toContain('Claude Code');
    store.close();
  });

  it('reopens a prepared run with its frozen envelope intact after restart', async () => {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const dbPath = path.join(root, 'agentdeck.db');
    const runsRoot = path.join(root, 'runs');

    const firstStore = new Store(dbPath);
    const repository = registerGitRepository(firstStore, repoPath);
    const submitted = await new DurableWorkEngine(firstStore, runsRoot, stubRuntimeReadinessSource()).submit(
      { ...workSpec(), repository, requestedBaseReference: 'main' },
    );
    const prepared = await new DurableWorkEngine(firstStore, runsRoot, stubRuntimeReadinessSource()).prepare(submitted.id);
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = new DurableWorkEngine(reopenedStore, runsRoot).get(submitted.id);

    expect(reopened?.envelope).toEqual(prepared.envelope);
    reopenedStore.close();
  });

  it('creates a clean worktree even when the source checkout has untracked files and dirty tracked files', async () => {
    const { repoPath, store, repository, engine } = setUp();
    const headSha = git(repoPath, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'uncommitted local edit\n');
    fs.writeFileSync(path.join(repoPath, 'scratch.txt'), 'never committed\n');
    const submitted = await submitRun(engine, repository);

    const prepared = await engine.prepare(submitted.id);

    expect(prepared.preparation.state).toBe('ready');
    expect(prepared.preparation.baseCommit).toBe(headSha);
    const worktreePath = prepared.preparation.worktreePath!;
    expect(fs.readFileSync(path.join(worktreePath, 'README.md'), 'utf8')).toBe('fixture\n');
    expect(fs.existsSync(path.join(worktreePath, 'scratch.txt'))).toBe(false);
    store.close();
  });

  it('fails with a precise, recoverable explanation on a worktree path collision, leaving it untouched', async () => {
    const { store, repository, runsRoot, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    const collidingPath = runWorktreePath(runsRoot, submitted.id);
    fs.mkdirSync(collidingPath, { recursive: true });
    fs.writeFileSync(path.join(collidingPath, 'keep.txt'), 'pre-existing\n');

    await expect(engine.prepare(submitted.id)).rejects.toThrow(/Worktree path already exists/);

    const run = engine.get(submitted.id)!;
    expect(run.status).toBe('preparing');
    expect(run.preparation.state).toBe('failed');
    expect(run.preparation.error).toMatch(/Worktree path already exists/);
    expect(fs.readFileSync(path.join(collidingPath, 'keep.txt'), 'utf8')).toBe('pre-existing\n');
    store.close();
  });

  it('fails with a precise, recoverable explanation on a branch-name collision', async () => {
    const { repoPath, store, repository, runsRoot, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    git(repoPath, 'branch', runBranchName(submitted.id));

    await expect(engine.prepare(submitted.id)).rejects.toThrow(/Branch already exists/);

    const run = engine.get(submitted.id)!;
    expect(run.preparation.state).toBe('failed');
    expect(run.preparation.error).toMatch(/Branch already exists/);
    expect(fs.existsSync(runWorktreePath(runsRoot, submitted.id))).toBe(false);
    store.close();
  });

  it('fails clearly when the requested base reference does not exist locally, creating no worktree', async () => {
    const { store, repository, runsRoot, engine } = setUp();
    const submitted = await submitRun(engine, repository, { requestedBaseReference: 'refs/heads/does-not-exist' });

    await expect(engine.prepare(submitted.id)).rejects.toThrow(/does not exist locally/);

    const run = engine.get(submitted.id)!;
    expect(run.preparation.state).toBe('failed');
    expect(fs.existsSync(runWorktreePath(runsRoot, submitted.id))).toBe(false);
    store.close();
  });

  it('rejects preparation once the Repository no longer exists at its recorded path', async () => {
    const { repoPath, store, repository, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    fs.rmSync(repoPath, { recursive: true, force: true });

    await expect(engine.prepare(submitted.id)).rejects.toThrow(/no longer exists/);
    expect(engine.get(submitted.id)!.preparation.state).toBe('failed');
    store.close();
  });

  it('does not recreate or fail a worktree that is already ready', async () => {
    const { store, repository, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    const ready = await engine.prepare(submitted.id);

    const repeated = await engine.prepare(submitted.id);

    expect(repeated).toEqual(ready);
    store.close();
  });

  it('rejects preparing an unknown run', async () => {
    const { store, engine } = setUp();
    await expect(engine.prepare('does-not-exist')).rejects.toThrow(RunNotFoundError);
    store.close();
  });

  it('reopens a prepared run with its resolved base commit and worktree intact after restart', async () => {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const dbPath = path.join(root, 'agentdeck.db');
    const runsRoot = path.join(root, 'runs');

    const firstStore = new Store(dbPath);
    const repository = registerGitRepository(firstStore, repoPath);
    const submitted = await new DurableWorkEngine(firstStore, runsRoot).submit(
      { ...workSpec(), repository, requestedBaseReference: 'main' },
    );
    const prepared = await new DurableWorkEngine(firstStore, runsRoot).prepare(submitted.id);
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = new DurableWorkEngine(reopenedStore, runsRoot).get(submitted.id);

    expect(reopened).toEqual(prepared);
    expect(fs.existsSync(prepared.preparation.worktreePath!)).toBe(true);
    reopenedStore.close();
  });

  it('cancellation preserves an already-created worktree for inspection', async () => {
    const { store, repository, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    const prepared = await engine.prepare(submitted.id);

    const cancelled = await engine.cancel(submitted.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.preparation).toEqual(prepared.preparation);
    expect(fs.existsSync(prepared.preparation.worktreePath!)).toBe(true);
    store.close();
  });

  it('rejects cancelling an unknown run', async () => {
    const { store, engine } = setUp();
    await expect(engine.cancel('does-not-exist')).rejects.toThrow(RunNotFoundError);
    store.close();
  });

  it('refuses to prepare a cancelled run, leaving its worktree exactly as it was', async () => {
    const { store, repository, engine } = setUp();
    const submitted = await submitRun(engine, repository);
    const prepared = await engine.prepare(submitted.id);
    await engine.cancel(submitted.id);

    await expect(engine.prepare(submitted.id)).rejects.toThrow(InvalidRunStateError);

    expect(engine.get(submitted.id)?.preparation).toEqual(prepared.preparation);
    store.close();
  });
});

describe('DurableWorkEngine.start', () => {
  function setUp(runtimeAdapters?: ConstructorParameters<typeof DurableWorkEngine>[3]) {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const store = new Store(':memory:');
    const repository = registerGitRepository(store, repoPath);
    const runsRoot = path.join(root, 'runs');
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource(), runtimeAdapters);
    return { root, repoPath, store, repository, runsRoot, engine };
  }

  async function submitAndPrepare(engine: DurableWorkEngine, repository: RunRepository, overrides: Partial<WorkSpec> = {}) {
    const submitted = await engine.submit({
      ...workSpec(), repository, requestedBaseReference: 'main', ...overrides,
    });
    return engine.prepare(submitted.id);
  }

  async function waitForSettled(engine: DurableWorkEngine, runId: string) {
    await vi.waitUntil(() => {
      const run = engine.get(runId);
      return run !== undefined && run.attempt.state !== 'running' && run.attempt.state !== 'idle';
    });
    return engine.get(runId)!;
  }

  it('rejects starting an Attempt before the worktree is prepared', async () => {
    const { store, repository, engine } = setUp();
    const submitted = await engine.submit({ ...workSpec(), repository, requestedBaseReference: 'main' });

    await expect(engine.start(submitted.id)).rejects.toThrow(/prepared/);
    store.close();
  });

  it('rejects starting an Attempt when no preferred runtime satisfies the envelope', async () => {
    const { store, repository, engine } = setUp();
    const prepared = await submitAndPrepare(engine, repository, { runtimePreference: ['claude'] });
    expect(prepared.envelope.state).toBe('refused');

    await expect(engine.start(prepared.id)).rejects.toThrow(/capability envelope/);
    store.close();
  });

  it('rejects starting an Attempt for a runtime with no wired adapter', async () => {
    const { store, repository, engine } = setUp({});
    const prepared = await submitAndPrepare(engine, repository);

    await expect(engine.start(prepared.id)).rejects.toThrow(UnsupportedRuntimeError);
    store.close();
  });

  it('rejects starting an unknown run', async () => {
    const { store, engine } = setUp();
    await expect(engine.start('does-not-exist')).rejects.toThrow(RunNotFoundError);
    store.close();
  });

  it('starts one Codex Attempt in the prepared worktree, reporting ordered structured progress to completion', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const { store, repository, engine } = setUp({
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }),
    });
    const prepared = await submitAndPrepare(engine, repository);

    const started = await engine.start(prepared.id);

    expect(started.status).toBe('running');
    expect(started.attempt).toMatchObject({ state: 'running', runtime: 'codex' });

    const settled = await waitForSettled(engine, prepared.id);
    expect(settled.status).toBe('completed');
    expect(settled.attempt.state).toBe('completed');
    if (settled.attempt.state !== 'completed') throw new Error('expected completed');
    expect(settled.attempt.events.map((event) => event.kind)).toEqual([
      'lifecycle', 'lifecycle', 'tool-activity', 'tool-activity', 'message', 'usage', 'lifecycle', 'completion',
    ]);
    expect(settled.attempt.events[0]).toMatchObject({ kind: 'lifecycle', phase: 'attempt-started' });
    expect(fake.writes.some((line) => line.includes(prepared.preparation.worktreePath!))).toBe(true);
    store.close();
  });

  it('never leaks the Codex provider conversation id into the stored Run', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success', threadId: 'thread-should-stay-internal' });
    const { store, repository, engine } = setUp({
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }),
    });
    const prepared = await submitAndPrepare(engine, repository);
    await engine.start(prepared.id);

    const settled = await waitForSettled(engine, prepared.id);

    expect(JSON.stringify(settled)).not.toContain('thread-should-stay-internal');
    store.close();
  });

  it('ends a Run in failed status with a precise reason when the Attempt fails', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'turn-failure' });
    const { store, repository, engine } = setUp({
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }),
    });
    const prepared = await submitAndPrepare(engine, repository);
    await engine.start(prepared.id);

    const settled = await waitForSettled(engine, prepared.id);

    expect(settled.status).toBe('failed');
    expect(settled.attempt).toMatchObject({ state: 'failed', reason: 'The sandboxed command exited non-zero.' });
    store.close();
  });

  it('never leaves a Run permanently running when Codex rejects the objective-start request', async () => {
    // The app-server double answers 'turn/start' with a JSON-RPC error and
    // then stays alive and silent forever — no notification, no exit. Before
    // the objective was tracked with request(), that error was dropped and
    // the Run sat in 'running' with only 'attempt-started' recorded, with
    // nothing left that could ever settle it.
    const fake = createFakeCodexAppServer({ behavior: 'objective-start-unsupported' });
    const { store, repository, engine } = setUp({
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }),
    });
    const prepared = await submitAndPrepare(engine, repository);
    const started = await engine.start(prepared.id);
    expect(started.status).toBe('running');

    const settled = await waitForSettled(engine, prepared.id);

    expect(settled.status).toBe('failed');
    expect(settled.attempt).toMatchObject({
      state: 'failed', reason: expect.stringContaining('Method not found: turn/start'),
    });
    store.close();
  });

  it('refuses to start a second Attempt once one has already been started', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const { store, repository, engine } = setUp({
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }),
    });
    const prepared = await submitAndPrepare(engine, repository);
    await engine.start(prepared.id);

    await expect(engine.start(prepared.id)).rejects.toThrow(/already been started/);
    await waitForSettled(engine, prepared.id);
    store.close();
  });

  it('persists Attempt progress durably: a fresh engine on the same store observes the completed Attempt', async () => {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const dbPath = path.join(root, 'agentdeck.db');
    const runsRoot = path.join(root, 'runs');
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const adapters = { codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) };

    const firstStore = new Store(dbPath);
    const repository = registerGitRepository(firstStore, repoPath);
    const firstEngine = new DurableWorkEngine(firstStore, runsRoot, stubRuntimeReadinessSource(), adapters);
    const prepared = await submitAndPrepare(firstEngine, repository);
    await firstEngine.start(prepared.id);
    await waitForSettled(firstEngine, prepared.id);
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = new DurableWorkEngine(reopenedStore, runsRoot).get(prepared.id);

    expect(reopened?.status).toBe('completed');
    expect(reopened?.attempt.state).toBe('completed');
    reopenedStore.close();
  });

  it('lets a cancellation surface while the Attempt is still running, without hiding a later real terminal outcome', async () => {
    const { store, repository, engine } = setUp();
    const prepared = await submitAndPrepare(engine, repository);
    // Ticket 06 doesn't stop the underlying process (ticket 09's "safe
    // controls" does) — this simulates the Attempt still being 'running'
    // durably when cancel() is called.
    store.startAttempt({
      id: 'attempt-cancel-1', runId: prepared.id, runtime: 'codex', startedAt: new Date().toISOString(),
    });
    expect(engine.get(prepared.id)?.status).toBe('running');

    const cancelled = await engine.cancel(prepared.id);

    expect(cancelled.status).toBe('cancelled');
    expect(engine.get(prepared.id)?.status).toBe('cancelled');

    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: prepared.id,
      attemptId: 'attempt-cancel-1',
      event: {
        kind: 'completion', sequence: 0, at: new Date().toISOString(), outcome: 'success',
      },
    }));

    expect(engine.get(prepared.id)?.status).toBe('completed');
    store.close();
  });
});

describe('DurableWorkEngine.resolveAttention', () => {
  function setUp(spawn: ReturnType<typeof createFakeCodexAppServer>['spawn']) {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const store = new Store(':memory:');
    const repository = registerGitRepository(store, repoPath);
    const runsRoot = path.join(root, 'runs');
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource(), {
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn }),
    });
    return { store, repository, engine };
  }

  async function submitPrepareAndStart(engine: DurableWorkEngine, repository: RunRepository) {
    const submitted = await engine.submit({ ...workSpec(), repository, requestedBaseReference: 'main' });
    await engine.prepare(submitted.id);
    return engine.start(submitted.id);
  }

  async function waitForPendingAttention(engine: DurableWorkEngine, runId: string) {
    await vi.waitUntil(() => engine.get(runId)?.pendingAttention !== undefined);
    return engine.get(runId)!.pendingAttention!;
  }

  async function waitForSettled(engine: DurableWorkEngine, runId: string) {
    await vi.waitUntil(() => {
      const run = engine.get(runId);
      return run !== undefined && run.attempt.state !== 'running' && run.attempt.state !== 'idle';
    });
    return engine.get(runId)!;
  }

  it('reports an approval request as durable Run attention with a human-readable reason and reflects waiting_approval on the Run', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request', attentionParams: { command: 'rm -rf node_modules' } });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);

    const pending = await waitForPendingAttention(engine, started.id);

    expect(pending).toMatchObject({ kind: 'approval', reason: expect.stringContaining('rm -rf node_modules') });
    expect(engine.get(started.id)?.status).toBe('waiting_approval');
    store.close();
  });

  it('resumes the Attempt exactly once: approving lets it continue to completion, and a second resolution of the same request is refused', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);

    const resolved = await engine.resolveAttention(started.id, pending.id, { kind: 'approve' });
    expect(resolved.pendingAttention).toBeUndefined();

    await expect(engine.resolveAttention(started.id, pending.id, { kind: 'approve' }))
      .rejects.toThrow(RunAttentionNotPendingError);

    const settled = await waitForSettled(engine, started.id);
    expect(settled.status).toBe('completed');
    if (settled.attempt.state !== 'completed') throw new Error('expected completed');
    const resolvedEvents = settled.attempt.events.filter((event) => event.kind === 'attention-resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({ kind: 'attention-resolved', attentionId: pending.id, decision: 'approved' });
    store.close();
  });

  it('never drops or collides an event the runtime pushes right after resolution — the resolver and the adapter mint sequence numbers independently and must never race', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);

    await engine.resolveAttention(started.id, pending.id, { kind: 'approve' });
    const settled = await waitForSettled(engine, started.id);

    if (settled.attempt.state !== 'completed') throw new Error('expected completed');
    const sequences = settled.attempt.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b)); // strictly ordered, no re-shuffling
    expect(new Set(sequences).size).toBe(sequences.length); // no two events share a sequence number
    // The fixture's post-approval turn (a fresh agent message, usage, and
    // turn/completed) must all still be present — proving nothing the
    // adapter pushed immediately after the decision was silently dropped
    // by a sequence-number collision with the attention-resolved event.
    expect(settled.attempt.events).toContainEqual(
      expect.objectContaining({ kind: 'message', text: 'Continued after the pending attention request was resolved.' }),
    );
    expect(settled.attempt.events.at(-1)).toMatchObject({ kind: 'completion', outcome: 'success' });
    store.close();
  });

  it('relays a denial to the runtime and never lets a denied request be resolved again', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);

    await engine.resolveAttention(started.id, pending.id, { kind: 'deny' });

    expect(fake.attentionResponses).toEqual([{ decision: 'denied' }]);
    await expect(engine.resolveAttention(started.id, pending.id, { kind: 'deny' }))
      .rejects.toThrow(RunAttentionNotPendingError);
    await waitForSettled(engine, started.id);
    store.close();
  });

  it('relays clarifying input to the runtime without ever changing the frozen spec or envelope (AC5)', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request', attentionMethod: 'thread/requestClarification' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);
    expect(pending.kind).toBe('input');
    const frozenSpec = started.spec;
    const frozenEnvelope = started.envelope;

    const resolved = await engine.resolveAttention(started.id, pending.id, { kind: 'input', value: 'Use TypeScript strict mode.' });

    expect(fake.attentionResponses).toEqual([{ value: 'Use TypeScript strict mode.' }]);
    expect(resolved.spec).toEqual(frozenSpec);
    expect(resolved.envelope).toEqual(frozenEnvelope);
    const settled = await waitForSettled(engine, started.id);
    expect(settled.spec).toEqual(frozenSpec);
    expect(settled.envelope).toEqual(frozenEnvelope);
    if (settled.attempt.state !== 'completed') throw new Error('expected completed');
    expect(settled.attempt.events).toContainEqual(
      expect.objectContaining({ kind: 'attention-resolved', decision: 'provided', input: 'Use TypeScript strict mode.' }),
    );
    store.close();
  });

  it('refuses to resolve an approval request with input, and an input request with approve/deny', async () => {
    const approvalFake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store: approvalStore, repository: approvalRepo, engine: approvalEngine } = setUp(approvalFake.spawn);
    const approvalRun = await submitPrepareAndStart(approvalEngine, approvalRepo);
    const approvalPending = await waitForPendingAttention(approvalEngine, approvalRun.id);

    await expect(approvalEngine.resolveAttention(approvalRun.id, approvalPending.id, { kind: 'input', value: 'nope' }))
      .rejects.toThrow(InvalidRunStateError);
    await approvalEngine.resolveAttention(approvalRun.id, approvalPending.id, { kind: 'approve' });
    await waitForSettled(approvalEngine, approvalRun.id);
    approvalStore.close();

    const inputFake = createFakeCodexAppServer({ behavior: 'attention-request', attentionMethod: 'thread/requestClarification' });
    const { store: inputStore, repository: inputRepo, engine: inputEngine } = setUp(inputFake.spawn);
    const inputRun = await submitPrepareAndStart(inputEngine, inputRepo);
    const inputPending = await waitForPendingAttention(inputEngine, inputRun.id);

    await expect(inputEngine.resolveAttention(inputRun.id, inputPending.id, { kind: 'approve' }))
      .rejects.toThrow(InvalidRunStateError);
    await inputEngine.resolveAttention(inputRun.id, inputPending.id, { kind: 'input', value: 'ok' });
    await waitForSettled(inputEngine, inputRun.id);
    inputStore.close();
  });

  it('rejects resolving attention for an unknown Run and a mismatched attentionId', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);

    await expect(engine.resolveAttention('does-not-exist', pending.id, { kind: 'approve' })).rejects.toThrow(RunNotFoundError);
    await expect(engine.resolveAttention(started.id, 'wrong-attention-id', { kind: 'approve' }))
      .rejects.toThrow(RunAttentionNotPendingError);

    await engine.resolveAttention(started.id, pending.id, { kind: 'approve' });
    await waitForSettled(engine, started.id);
    store.close();
  });
});
