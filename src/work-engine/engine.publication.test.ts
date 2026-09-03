// Ticket 13: publication as an explicit, durable, admin-authorized external
// effect after local verified completion. Each Run below is driven to a real
// 'completed' status with a real delivery commit (ticket 10's path, fake
// Codex app-server, trivial required gate) inside a real linked worktree
// whose origin is a local bare repository — so "nothing was pushed" is
// asserted against actual git state, not a mock's call count alone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeCodexAppServer } from '../test-fixtures/codex-attempt.js';
import { stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { createScriptedSequence } from '../test-fixtures/scripted-sequence.js';
import { Store } from '../store/index.js';
import { systemClock } from './clock.js';
import { DurableWorkEngine, InvalidRunStateError, PolicyDeniedError } from './engine.js';
import { resolveLocalPrincipal } from './principal.js';
import { createGitRunPublisher } from './publication-git.js';
import { RemoteUnobservableError } from './publication.js';
import type { RemoteObservation, RunPublisher } from './publication.js';
import { deriveRunResult } from './run-result.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import type { RunActor, RunRepository, WorkRun, WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-engine-publication-'));
  tempDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const admin = { id: 'local:admin', displayName: 'admin' };
const collaborator: RunActor = {
  principal: { id: 'collab-1', displayName: 'Alice' },
  device: { id: 'device-1', label: "Alice's phone" },
  grants: { repositoryIds: [], profileIds: [] },
};

const pullRequest = { number: 7, url: 'https://github.com/example/project/pull/7', title: 'Add durable managed work', draft: true };

/** A scripted publisher whose observe() answers are consumed in order (last repeats); push/createDraftPullRequest succeed unless told otherwise. */
function scriptedPublisher(observations: Array<RemoteObservation | Error | (() => RemoteObservation | Error)>, options: {
  head?: () => Promise<{ commit: string; branch?: string }>;
  push?: Error;
  createPullRequest?: Error;
} = {}) {
  const nextObservation = createScriptedSequence<RemoteObservation | Error>(observations);
  const publisher: RunPublisher = {
    localHead: vi.fn(async (worktreePath: string) => options.head ? options.head() : ({
      commit: git(worktreePath, 'rev-parse', 'HEAD'), branch: git(worktreePath, 'symbolic-ref', '--short', 'HEAD'),
    })),
    observe: vi.fn(async () => {
      const value = nextObservation();
      if (value instanceof Error) throw value;
      return value;
    }),
    push: vi.fn(async () => { if (options.push) throw options.push; }),
    createDraftPullRequest: vi.fn(async () => {
      if (options.createPullRequest) throw options.createPullRequest;
      return pullRequest;
    }),
  };
  return publisher;
}

interface Harness {
  root: string;
  dbPath: string;
  runsRoot: string;
  origin: string;
  store: Store;
  repository: RunRepository;
  engine: DurableWorkEngine;
  adapters: ConstructorParameters<typeof DurableWorkEngine>[3];
}

function setUp(publisher: RunPublisher = createGitRunPublisher()): Harness {
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
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '--bare', origin);
  git(repoPath, 'remote', 'add', 'origin', origin);
  git(repoPath, 'push', 'origin', 'main');

  const dbPath = path.join(root, 'agentdeck.db');
  const store = new Store(dbPath);
  const repository: RunRepository = { id: repoPath, name: 'repo', path: repoPath };
  store.upsertRepo(repository);
  store.setRepositoryVerificationPolicy(repository.id, { kind: 'required', gates: [{ name: 'ok', command: 'true' }] });
  const runsRoot = path.join(root, 'runs');
  const fake = createFakeCodexAppServer({ behavior: 'success' });
  const adapters = { codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn }) };
  const engine = newEngine(store, runsRoot, adapters, publisher);
  return {
    root, dbPath, runsRoot, origin, store, repository, engine, adapters,
  };
}

function newEngine(store: Store, runsRoot: string, adapters: Harness['adapters'], publisher: RunPublisher): DurableWorkEngine {
  return new DurableWorkEngine(
    store, runsRoot, stubRuntimeReadinessSource(), adapters, undefined, systemClock, () => admin, publisher,
  );
}

function spec(repository: RunRepository, overrides: Partial<WorkSpec> = {}): WorkSpec {
  return {
    objective: 'Add durable managed work',
    acceptanceCriteria: ['The result is published only on request'],
    repository,
    requestedBaseReference: 'main',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 3_600_000 },
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'pull-request',
    ...overrides,
  };
}

/** Submits, prepares, makes a change, and runs the Attempt to a settled state — 'completed' with a delivery commit for the default spec. */
async function completeRun(harness: Harness, overrides: Partial<WorkSpec> = {}, change = true): Promise<WorkRun> {
  const { engine, repository } = harness;
  const prepared = await engine.prepare((await engine.submit(spec(repository, overrides))).id);
  if (change) fs.writeFileSync(path.join(prepared.preparation.worktreePath!, 'new-file.txt'), 'hello\n');
  await engine.start(prepared.id);
  await vi.waitUntil(() => {
    const run = engine.get(prepared.id);
    return run !== undefined && run.attempt.state !== 'running' && run.attempt.state !== 'idle';
  });
  return engine.get(prepared.id)!;
}

function remoteBranches(origin: string): string[] {
  return git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
}

describe('DurableWorkEngine.publish (ticket 13)', () => {
  it('never pushes or opens a pull request as part of local completion, even when the requester asked for a pull request (AC1)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness);

    expect(settled.status).toBe('completed');
    expect(settled.attempt.state === 'completed' && settled.attempt.events.some((event) => event.kind === 'commit-created')).toBe(true);
    expect(settled.publication).toBeUndefined();
    // Real git state: origin still has only main.
    expect(remoteBranches(harness.origin)).toEqual(['main']);
    harness.store.close();
  });

  it('refuses a collaborator from a direct engine call, recording no intent and no activity (AC2: collaborator refusal)', async () => {
    const harness = setUp(scriptedPublisher([{ remoteUrl: 'origin-url' }]));
    const settled = await completeRun(harness);

    await expect(harness.engine.publish(settled.id, {}, collaborator)).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(harness.engine.publish(settled.id, {}, collaborator)).rejects.toMatchObject({ rule: 'publish-admin-only' });
    expect(harness.engine.get(settled.id)?.publication).toBeUndefined();
    expect(harness.engine.listActivity(settled.id).map((activity) => activity.kind)).not.toContain('publish-authorized');
    expect(remoteBranches(harness.origin)).toEqual(['main']);
    harness.store.close();
  });

  it('refuses anything but a verified, completed Run with a delivery commit', async () => {
    const harness = setUp();
    harness.store.setRepositoryVerificationPolicy(harness.repository.id, { kind: 'no-verification' });
    const unverified = await completeRun(harness);
    expect(unverified.status).toBe('completed_unverified');
    await expect(harness.engine.publish(unverified.id)).rejects.toBeInstanceOf(InvalidRunStateError);

    harness.store.setRepositoryVerificationPolicy(harness.repository.id, { kind: 'required', gates: [{ name: 'ok', command: 'true' }] });
    const noChanges = await completeRun(harness, {}, false);
    expect(noChanges.status).toBe('completed');
    await expect(harness.engine.publish(noChanges.id)).rejects.toThrow('no local commit');

    const workingTree = await completeRun(harness, { requestedDeliveryResult: 'working-tree' });
    await expect(harness.engine.publish(workingTree.id)).rejects.toThrow('no local commit');
    await expect(harness.engine.publish('no-such-run')).rejects.toThrow('no such run');
    expect(remoteBranches(harness.origin)).toEqual(['main']);
    harness.store.close();
  });

  it('pushes the delivery commit to origin and records remote, branch, commit, authorizer, and activity (AC4, real git)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const commit = settled.attempt.state === 'completed'
      ? settled.attempt.events.find((event) => event.kind === 'commit-created') : undefined;
    if (commit?.kind !== 'commit-created') throw new Error('expected a delivery commit');

    const published = await harness.engine.publish(settled.id);

    expect(published.publication).toMatchObject({
      target: 'push',
      state: 'succeeded',
      commit: commit.sha,
      branch: commit.branch,
      idempotencyKey: `run:${settled.id}:commit:${commit.sha}`,
      authorizedBy: admin,
      executions: 1,
      result: { remote: { name: 'origin', url: harness.origin }, branch: commit.branch, commit: commit.sha },
    });
    expect(published.publication?.result?.pullRequest).toBeUndefined();
    expect(git(harness.origin, 'rev-parse', `refs/heads/${commit.branch}`)).toBe(commit.sha);
    expect(harness.engine.listActivity(settled.id).at(-1)).toMatchObject({ kind: 'publish-authorized', principal: admin });
    expect(deriveRunResult(published)?.publication?.state).toBe('succeeded');
    harness.store.close();
  });

  it('persists the intent — with its stable identity — before any command runs, and opens a draft pull request for a pull-request delivery (AC3/AC4)', async () => {
    let observedDuringExecution: ReturnType<Store['getRunPublication']>;
    let harness!: Harness;
    const publisher = scriptedPublisher([() => {
      observedDuringExecution = harness.store.getRunPublication(harness.store.listRuns()[0]!.id);
      return { remoteUrl: 'git@github.com:example/project.git' };
    }]);
    harness = setUp(publisher);
    const settled = await completeRun(harness);

    const published = await harness.engine.publish(settled.id);

    expect(observedDuringExecution).toMatchObject({ state: 'executing', executions: 1, target: 'draft-pull-request' });
    expect(published.publication).toMatchObject({
      state: 'succeeded',
      result: { pullRequest, remote: { url: 'git@github.com:example/project.git' } },
    });
    expect(publisher.createDraftPullRequest).toHaveBeenCalledWith(settled.preparation.worktreePath, expect.objectContaining({
      base: 'main', title: 'Add durable managed work', body: expect.stringContaining(`AgentDeck-Run: ${settled.id}`),
    }));
    harness.store.close();
  });

  it('treats a repeated command as the same intent: no second push, same identity, same execution count (AC3: repeated command)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const first = await harness.engine.publish(settled.id);
    const second = await harness.engine.publish(settled.id);

    expect(second.publication).toEqual(first.publication);
    expect(second.publication?.executions).toBe(1);
    harness.store.close();
  });

  it('joins a concurrent second command to the in-flight execution instead of pushing twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publisher = scriptedPublisher([() => ({ remoteUrl: 'origin-url' })]);
    (publisher.push as ReturnType<typeof vi.fn>).mockImplementation(async () => { await gate; });
    const harness = setUp(publisher);
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const first = harness.engine.publish(settled.id);
    const second = harness.engine.publish(settled.id);
    await vi.waitUntil(() => harness.engine.get(settled.id)?.publication?.state === 'executing');
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.publication?.state).toBe('succeeded');
    expect(b.publication).toEqual(a.publication);
    expect(publisher.push).toHaveBeenCalledTimes(1);
    harness.store.close();
  });

  it('fails without pushing when the Run branch moved after the delivery commit (Git divergence, real git)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const worktree = settled.preparation.worktreePath!;
    fs.writeFileSync(path.join(worktree, 'later.txt'), 'later\n');
    git(worktree, 'add', 'later.txt');
    git(worktree, 'commit', '-m', 'a later, unauthorized commit');

    const published = await harness.engine.publish(settled.id);

    expect(published.publication).toMatchObject({ state: 'failed', reason: expect.stringContaining('not the authorized commit') });
    expect(remoteBranches(harness.origin)).toEqual(['main']);
    harness.store.close();
  });

  it('fails plainly when origin is unreachable on a first attempt, and the admin can retry once it is back (network failure, real git)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    git(harness.repository.path, 'remote', 'set-url', 'origin', path.join(harness.root, 'unplugged.git'));

    const failed = await harness.engine.publish(settled.id);
    expect(failed.publication).toMatchObject({ state: 'failed', executions: 1, reason: expect.stringContaining('nothing was published') });

    git(harness.repository.path, 'remote', 'set-url', 'origin', harness.origin);
    const retried = await harness.engine.publish(settled.id);
    expect(retried.publication).toMatchObject({ state: 'succeeded', executions: 2, id: failed.publication?.id });
    expect(retried.publication).not.toHaveProperty('reason');
    expect(remoteBranches(harness.origin).sort()).toEqual([failed.publication!.branch, 'main'].sort());
    harness.store.close();
  });

  it('becomes an explicit ambiguous state — not failed, not succeeded — when the push result cannot be proven, and stays that way until the admin acts (AC6)', async () => {
    const publisher = scriptedPublisher(
      [{ remoteUrl: 'origin-url' }, new RemoteUnobservableError('connection reset')],
      { push: new Error('timed out') },
    );
    const harness = setUp(publisher);
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const ambiguous = await harness.engine.publish(settled.id);
    expect(ambiguous.publication).toMatchObject({ state: 'ambiguous', reason: expect.stringContaining('could not be observed') });

    // Nothing resolves it on its own: a fresh process reconciles, but the
    // remote is still unobservable, so it stays ambiguous.
    harness.store.close();
    const reopenedStore = new Store(harness.dbPath);
    const reopened = newEngine(reopenedStore, harness.runsRoot, harness.adapters, publisher);
    await reopened.recover();
    expect(reopened.get(settled.id)?.publication?.state).toBe('ambiguous');
    expect(reopenedStore.listIncompleteRunPublications()).toEqual([]);

    // The admin acts: origin is observable again and already has the commit
    // — the retry proves success without pushing again.
    const commit = ambiguous.publication!.commit;
    const observable = scriptedPublisher([{ remoteUrl: 'origin-url', remoteCommit: commit }]);
    const acted = newEngine(reopenedStore, harness.runsRoot, harness.adapters, observable);
    const resolved = await acted.publish(settled.id);
    expect(resolved.publication).toMatchObject({ state: 'succeeded', executions: 2 });
    expect(observable.push).not.toHaveBeenCalled();
    reopenedStore.close();
  });

  it('reconciles observable remote state on restart before retrying an intent left executing — already-pushed work is not pushed again (AC5: restart)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness);
    const commit = settled.attempt.state === 'completed'
      ? settled.attempt.events.find((event) => event.kind === 'commit-created') : undefined;
    if (commit?.kind !== 'commit-created') throw new Error('expected a delivery commit');
    // Simulate a crash mid-push: the durable intent says 'executing', the
    // push actually landed on origin, and the pull request never happened.
    harness.store.createRunPublication({
      id: 'pub-crashed',
      runId: settled.id,
      idempotencyKey: `run:${settled.id}:commit:${commit.sha}`,
      target: 'draft-pull-request',
      commit: commit.sha,
      branch: commit.branch,
      state: 'executing',
      authorizedBy: admin,
      authorizedAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      executions: 1,
    });
    git(settled.preparation.worktreePath!, 'push', 'origin', `${commit.sha}:refs/heads/${commit.branch}`);
    harness.store.close();

    const publisher = scriptedPublisher([{ remoteUrl: harness.origin, remoteCommit: commit.sha }]);
    const reopenedStore = new Store(harness.dbPath);
    const reopened = newEngine(reopenedStore, harness.runsRoot, harness.adapters, publisher);
    await reopened.recover();
    await vi.waitUntil(() => reopened.get(settled.id)?.publication?.state === 'succeeded');

    expect(publisher.observe).toHaveBeenCalledWith(settled.preparation.worktreePath, commit.branch, { pullRequest: true });
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.createDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(reopened.get(settled.id)?.publication).toMatchObject({ id: 'pub-crashed', executions: 2, result: { pullRequest } });
    reopenedStore.close();
  });

  it('marks an intent left executing as ambiguous on restart when origin cannot be observed, never assuming either way (AC5/AC6)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const commit = settled.attempt.state === 'completed'
      ? settled.attempt.events.find((event) => event.kind === 'commit-created') : undefined;
    if (commit?.kind !== 'commit-created') throw new Error('expected a delivery commit');
    harness.store.createRunPublication({
      id: 'pub-crashed', runId: settled.id, idempotencyKey: `run:${settled.id}:commit:${commit.sha}`, target: 'push',
      commit: commit.sha, branch: commit.branch, state: 'executing', authorizedBy: admin,
      authorizedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', executions: 1,
    });
    harness.store.close();

    const publisher = scriptedPublisher([new RemoteUnobservableError('Could not resolve host')]);
    const reopenedStore = new Store(harness.dbPath);
    const reopened = newEngine(reopenedStore, harness.runsRoot, harness.adapters, publisher);
    await reopened.recover();
    await vi.waitUntil(() => reopened.get(settled.id)?.publication?.state !== 'executing');

    expect(reopened.get(settled.id)?.publication).toMatchObject({ state: 'ambiguous', reason: expect.stringContaining('earlier attempt') });
    expect(publisher.push).not.toHaveBeenCalled();
    reopenedStore.close();
  });

  it('completes an intent that was authorized but never started before the restart, from a clean observe (AC5)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const commit = settled.attempt.state === 'completed'
      ? settled.attempt.events.find((event) => event.kind === 'commit-created') : undefined;
    if (commit?.kind !== 'commit-created') throw new Error('expected a delivery commit');
    harness.store.createRunPublication({
      id: 'pub-authorized', runId: settled.id, idempotencyKey: `run:${settled.id}:commit:${commit.sha}`, target: 'push',
      commit: commit.sha, branch: commit.branch, state: 'authorized', authorizedBy: admin,
      authorizedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', executions: 0,
    });
    harness.store.close();

    const reopenedStore = new Store(harness.dbPath);
    const reopened = newEngine(reopenedStore, harness.runsRoot, harness.adapters, createGitRunPublisher());
    await reopened.recover();
    await vi.waitUntil(() => reopened.get(settled.id)?.publication?.state === 'succeeded');

    expect(git(harness.origin, 'rev-parse', `refs/heads/${commit.branch}`)).toBe(commit.sha);
    reopenedStore.close();
  });

  it('publishes from the Run worktree only, never touching the Repository checkout (Repository boundary)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const repoHeadBefore = git(harness.repository.path, 'rev-parse', 'HEAD');
    const repoStatusBefore = git(harness.repository.path, 'status', '--porcelain');

    await harness.engine.publish(settled.id);

    expect(git(harness.repository.path, 'rev-parse', 'HEAD')).toBe(repoHeadBefore);
    expect(git(harness.repository.path, 'status', '--porcelain')).toBe(repoStatusBefore);
    expect(git(harness.repository.path, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    harness.store.close();
  });

  it('defaults the local Principal source exactly like every other engine call', () => {
    expect(resolveLocalPrincipal().id.startsWith('local:')).toBe(true);
  });
});

describe('DurableWorkEngine.publish re-targeting (ticket 13 fix: a run_publications row is per Run, not per target)', () => {
  it('lets the admin re-authorize a different target after a definite failure — a failed intent is a proven no-op, safe to retry', async () => {
    // A scripted publisher, not the real git one: the second (retargeted)
    // attempt needs a draft pull request to succeed, and this suite never
    // relies on a real `gh` CLI being installed/authenticated — see the
    // existing 'opens a draft pull request' test above for the same reason.
    const publisher = scriptedPublisher([
      new RemoteUnobservableError('Could not resolve host: github.com'),
      { remoteUrl: 'origin-url' },
    ]);
    const harness = setUp(publisher);
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const failed = await harness.engine.publish(settled.id, { target: 'push' });
    expect(failed.publication).toMatchObject({ target: 'push', state: 'failed' });

    const retargeted = await harness.engine.publish(settled.id, { target: 'draft-pull-request' });

    expect(retargeted.publication).toMatchObject({
      id: failed.publication!.id, target: 'draft-pull-request', state: 'succeeded', executions: 1, result: { pullRequest },
    });
    expect(retargeted.publication).not.toHaveProperty('reason');
    harness.store.close();
  });

  it('lets the admin additionally open a draft pull request for a Run already published as a plain push (AC4: a succeeded intent can still be extended)', async () => {
    const harness = setUp();
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });
    const commit = settled.attempt.state === 'completed'
      ? settled.attempt.events.find((event) => event.kind === 'commit-created') : undefined;
    if (commit?.kind !== 'commit-created') throw new Error('expected a delivery commit');

    // The push itself is real git, through the harness's default publisher.
    const pushed = await harness.engine.publish(settled.id, { target: 'push' });
    expect(pushed.publication).toMatchObject({ target: 'push', state: 'succeeded' });
    expect(pushed.publication?.result?.pullRequest).toBeUndefined();
    expect(git(harness.origin, 'rev-parse', `refs/heads/${commit.branch}`)).toBe(commit.sha);

    // A scripted publisher for the PR half only — this suite never relies
    // on a real `gh` CLI. Same store, so it sees the same durable intent.
    const publisher = scriptedPublisher([{ remoteUrl: harness.origin, remoteCommit: commit.sha }]);
    const withPrEngine = newEngine(harness.store, harness.runsRoot, harness.adapters, publisher);

    const withPr = await withPrEngine.publish(settled.id, { target: 'draft-pull-request' });

    expect(withPr.publication).toMatchObject({
      id: pushed.publication!.id, target: 'draft-pull-request', state: 'succeeded', result: { pullRequest },
    });
    expect(publisher.push).not.toHaveBeenCalled();
    harness.store.close();
  });

  it('refuses to change target while the intent is ambiguous — AC6 requires reconciling it first, not sidestepping it', async () => {
    const publisher = scriptedPublisher(
      [{ remoteUrl: 'origin-url' }, new RemoteUnobservableError('connection reset')],
      { push: new Error('timed out') },
    );
    const harness = setUp(publisher);
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const ambiguous = await harness.engine.publish(settled.id, { target: 'push' });
    expect(ambiguous.publication?.state).toBe('ambiguous');

    await expect(harness.engine.publish(settled.id, { target: 'draft-pull-request' }))
      .rejects.toMatchObject({ message: expect.stringContaining('reconcile it') });
    expect(harness.engine.get(settled.id)?.publication?.target).toBe('push');
    harness.store.close();
  });

  it('refuses to change target while an execution is actually in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publisher = scriptedPublisher([() => ({ remoteUrl: 'origin-url' })]);
    (publisher.push as ReturnType<typeof vi.fn>).mockImplementation(async () => { await gate; });
    const harness = setUp(publisher);
    const settled = await completeRun(harness, { requestedDeliveryResult: 'local-commit' });

    const inFlight = harness.engine.publish(settled.id, { target: 'push' });
    await vi.waitUntil(() => harness.engine.get(settled.id)?.publication?.state === 'executing');

    await expect(harness.engine.publish(settled.id, { target: 'draft-pull-request' }))
      .rejects.toMatchObject({ message: expect.stringContaining('currently executing') });

    release();
    await inFlight;
    harness.store.close();
  });
});
