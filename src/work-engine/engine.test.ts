import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { DurableWorkEngine, InvalidRunStateError, RunNotFoundError } from './engine.js';
import { runBranchName, runWorktreePath } from './prepare.js';
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
  function setUp() {
    const root = tempDir();
    const repoPath = path.join(root, 'repo');
    initGitRepo(repoPath);
    const store = new Store(':memory:');
    const repository = registerGitRepository(store, repoPath);
    const runsRoot = path.join(root, 'runs');
    const engine = new DurableWorkEngine(store, runsRoot);
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
