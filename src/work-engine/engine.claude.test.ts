// Ticket 14: Claude satisfies the same managed Attempt contract Codex
// already proves — driven end to end through the Work Engine, not just the
// adapter, so the behavior these tests pin is the observable one: a managed
// Attempt in the prepared worktree and capability envelope, approvals
// crossing the engine's one policy path, and a restart that ends the
// Attempt precisely instead of replaying its objective.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { createFakeClaudeCli } from '../test-fixtures/claude-attempt.js';
import { managedClaudeRuntimeReadinessReport, stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { Store } from '../store/index.js';
import { DurableWorkEngine, RunAttentionNotPendingError } from './engine.js';
import { MANAGED_ENVIRONMENT_ALLOWLIST } from './envelope.js';
import { createClaudeAttemptAdapter } from './runtimes/claude.js';
import type { RunRepository, WorkRun, WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-claude-attempt-'));
  tempDirectories.push(directory);
  return directory;
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
  store.setRepositoryVerificationPolicy(repository.id, { kind: 'no-verification' });
  return repository;
}

function claudeWorkSpec(repository: RunRepository): WorkSpec {
  return {
    objective: 'Add durable managed work',
    acceptanceCriteria: ['The queued run survives restart'],
    repository,
    requestedBaseReference: 'main',
    runtimePreference: ['claude'],
    budget: { maxWallClockMs: 3_600_000, maxModelTurns: 40 },
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'working-tree',
  };
}

function setUp(spawn: ReturnType<typeof createFakeClaudeCli>['spawn']) {
  const root = tempDir();
  const repoPath = path.join(root, 'repo');
  initGitRepo(repoPath);
  const store = new Store(path.join(root, 'agentdeck.db'));
  const repository = registerGitRepository(store, repoPath);
  const runsRoot = path.join(root, 'runs');
  const engine = new DurableWorkEngine(
    store,
    runsRoot,
    stubRuntimeReadinessSource(managedClaudeRuntimeReadinessReport),
    { claude: createClaudeAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-claude', spawn }) },
  );
  return {
    store, repository, engine, runsRoot, databasePath: path.join(root, 'agentdeck.db'),
  };
}

async function submitPrepareAndStart(engine: DurableWorkEngine, repository: RunRepository): Promise<WorkRun> {
  const submitted = await engine.submit(claudeWorkSpec(repository));
  await engine.prepare(submitted.id);
  return engine.start(submitted.id);
}

async function waitForSettled(engine: DurableWorkEngine, runId: string): Promise<WorkRun> {
  await vi.waitUntil(() => {
    const run = engine.get(runId);
    return run !== undefined && run.attempt.state !== 'running' && run.attempt.state !== 'idle';
  }, { timeout: 20_000 });
  return engine.get(runId)!;
}

async function waitForPendingAttention(engine: DurableWorkEngine, runId: string) {
  await vi.waitUntil(() => engine.get(runId)?.pendingAttention !== undefined, { timeout: 20_000 });
  return engine.get(runId)!.pendingAttention!;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('managed Claude Attempt (ticket 14 AC1/AC2)', () => {
  it('executes one managed Attempt in the prepared worktree and capability envelope', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const { store, repository, engine } = setUp(fake.spawn);

    const started = await submitPrepareAndStart(engine, repository);
    const settled = await waitForSettled(engine, started.id);

    if (started.envelope.state !== 'ready') throw new Error('expected a ready envelope');
    expect(started.envelope.capabilityEnvelope.runtime).toBe('claude');
    if (started.preparation.state !== 'ready') throw new Error('expected a ready worktree');
    // The Attempt ran inside the Run's own prepared worktree, never the
    // Repository itself, with only the envelope's allowlisted environment.
    expect(fake.envs).toHaveLength(1);
    expect(Object.keys(fake.envs[0]!).every((key) => MANAGED_ENVIRONMENT_ALLOWLIST.includes(key))).toBe(true);
    expect(settled.status).toBe('completed_unverified');
    store.close();
  });

  it('maps the whole runtime stream into the shared, durable event model', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success', sessionId: 'session-secret-identity' });
    const { store, repository, engine } = setUp(fake.spawn);

    const started = await submitPrepareAndStart(engine, repository);
    const settled = await waitForSettled(engine, started.id);

    if (settled.attempt.state !== 'completed') throw new Error('expected a completed Attempt');
    expect(settled.attempt.runtime).toBe('claude');
    const kinds = settled.attempt.events.map((event) => event.kind);
    expect(kinds).toContain('lifecycle');
    expect(kinds).toContain('tool-activity');
    expect(kinds).toContain('message');
    expect(kinds).toContain('usage');
    expect(kinds).toContain('completion');
    // AC3: the Claude session id never reaches shared Run storage.
    expect(JSON.stringify(settled)).not.toContain('session-secret-identity');
    store.close();
  });

  it('surfaces a permission request as durable Run attention and resumes the Attempt exactly once when it is approved', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);

    const pending = await waitForPendingAttention(engine, started.id);
    expect(pending).toMatchObject({ kind: 'approval', reason: expect.stringContaining('rm -rf node_modules') });
    expect(engine.get(started.id)?.status).toBe('waiting_approval');

    await engine.resolveAttention(started.id, pending.id, { kind: 'approve' });
    await expect(engine.resolveAttention(started.id, pending.id, { kind: 'approve' }))
      .rejects.toThrow(RunAttentionNotPendingError);

    const settled = await waitForSettled(engine, started.id);
    expect(fake.controlResponses).toEqual([
      { behavior: 'allow', updatedInput: { command: 'rm -rf node_modules', description: 'Clear installed packages' } },
    ]);
    if (settled.attempt.state !== 'completed') throw new Error('expected a completed Attempt');
    const resolutions = settled.attempt.events.filter((event) => event.kind === 'attention-resolved');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({ attentionId: pending.id, decision: 'approved' });
    store.close();
  });

  it('relays a denial to Claude without changing the frozen spec or envelope', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const started = await submitPrepareAndStart(engine, repository);
    const pending = await waitForPendingAttention(engine, started.id);

    const resolved = await engine.resolveAttention(started.id, pending.id, { kind: 'deny' });

    expect(fake.controlResponses).toEqual([
      { behavior: 'deny', message: 'The AgentDeck operator denied this action.' },
    ]);
    expect(resolved.spec).toEqual(started.spec);
    expect(resolved.envelope).toEqual(started.envelope);
    const settled = await waitForSettled(engine, started.id);
    expect(settled.spec).toEqual(started.spec);
    expect(settled.envelope).toEqual(started.envelope);
    store.close();
  });
});

describe('managed Claude Attempt recovery (ticket 14 AC4)', () => {
  it('ends an interrupted Claude Attempt with a precise reason, without replaying the objective or duplicating events', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const { store, repository, engine, runsRoot, databasePath } = setUp(fake.spawn);
    const submitted = await engine.submit(claudeWorkSpec(repository));
    await engine.prepare(submitted.id);
    // The durable shape a restart finds: an Attempt row still marked
    // running, with no live process anywhere to hand it back to.
    store.startAttempt({
      id: 'attempt-claude-1', runId: submitted.id, runtime: 'claude', startedAt: new Date().toISOString(),
    });
    expect(engine.get(submitted.id)?.status).toBe('running');
    store.close();

    const restartedStore = new Store(databasePath);
    const restartFake = createFakeClaudeCli({ behavior: 'success' });
    const restarted = new DurableWorkEngine(
      restartedStore,
      runsRoot,
      stubRuntimeReadinessSource(managedClaudeRuntimeReadinessReport),
      { claude: createClaudeAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: restartFake.spawn }) },
    );
    await restarted.recover();

    const recovered = restarted.get(submitted.id)!;
    expect(recovered.status).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected a failed Attempt');
    expect(recovered.attempt.events.at(-1)).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('Claude Code reports structured continuation support'),
    });
    // Recovery records a terminal fact; it never re-invokes the runtime.
    expect(restartFake.argv).toHaveLength(0);

    // AC4: recovering twice adds nothing — no duplicated durable history.
    const before = recovered.attempt.events.length;
    await restarted.recover();
    const again = restarted.get(submitted.id)!.attempt;
    if (again.state === 'idle') throw new Error('expected an Attempt');
    expect(again.events).toHaveLength(before);
    restartedStore.close();
  });
});
