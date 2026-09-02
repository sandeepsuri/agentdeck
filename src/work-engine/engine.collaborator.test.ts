// Ticket 12: a named collaborator's RunActor submitting and guiding a Run
// through DurableWorkEngine directly — the "direct Work Engine call" half
// of AC7's transport parity (work-routes.test.ts and ws.test.ts cover the
// REST/WebSocket halves against this exact same engine). engine.test.ts's
// existing 62 tests already prove every admin/no-actor call site is
// unaffected; this file is entirely about the new actor-aware behavior.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeCodexAppServer } from '../test-fixtures/codex-attempt.js';
import { stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { Store } from '../store/index.js';
import { DurableWorkEngine, PolicyDeniedError } from './engine.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import type { Profile, RunActor, RunRepository, WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-work-engine-collab-'));
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

/** What a collaborator's own request body looks like — deliberately wrong runtime/budget/verification/delivery, to prove submit() overwrites them from the named Profile rather than trusting these (AC4). */
function collaboratorRequestedSpec(repository: RunRepository, profileId: string): WorkSpec {
  return {
    objective: 'Fix the flaky login test',
    acceptanceCriteria: ['The test passes reliably'],
    repository,
    requestedBaseReference: 'main',
    runtimePreference: ['claude'], // the granted Profile only allows codex — see approvedProfile below
    budget: { maxWallClockMs: 999_999_999 }, // wildly larger than the Profile's
    verificationIntent: { required: false, commands: [] }, // Profile requires verification
    requestedDeliveryResult: 'pull-request', // Profile only allows local-commit
    profileId,
  };
}

const approvedProfile: Profile = {
  id: 'profile-1',
  name: 'Standard Codex run',
  runtimePreference: ['codex'],
  budget: { maxWallClockMs: 3_600_000, maxModelTurns: 40 },
  verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function setUp(spawn?: ReturnType<typeof createFakeCodexAppServer>['spawn']) {
  const root = tempDir();
  const repoPath = path.join(root, 'repo');
  initGitRepo(repoPath);
  const store = new Store(':memory:');
  const repository = registerGitRepository(store, repoPath);
  store.createProfile(approvedProfile);
  const engine = new DurableWorkEngine(store, path.join(root, 'runs'), stubRuntimeReadinessSource(), spawn ? {
    codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn }),
  } : undefined);
  return { store, repository, engine };
}

function collaboratorActor(repository: RunRepository, grantProfile = true): RunActor {
  return {
    principal: { id: 'collab-1', displayName: 'Alice' },
    device: { id: 'device-1', label: "Alice's phone" },
    grants: { repositoryIds: [repository.id], profileIds: grantProfile ? [approvedProfile.id] : [] },
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('DurableWorkEngine.submit with a collaborator RunActor (ticket 12 AC1/AC2/AC4)', () => {
  it('derives runtime/budget/verification/delivery from the granted Profile, ignoring the collaborator-supplied values entirely', async () => {
    const { store, repository, engine } = setUp();
    const actor = collaboratorActor(repository);

    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), actor);

    expect(run.spec.runtimePreference).toEqual(['codex']);
    expect(run.spec.budget).toEqual(approvedProfile.budget);
    expect(run.spec.verificationIntent).toEqual(approvedProfile.verificationIntent);
    expect(run.spec.requestedDeliveryResult).toBe('local-commit');
    expect(run.spec.profileId).toBe('profile-1');
    store.close();
  });

  it('records the collaborator (not the local admin) as the Run principal', async () => {
    const { store, repository, engine } = setUp();
    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), collaboratorActor(repository));
    expect(run.principal).toEqual({ id: 'collab-1', displayName: 'Alice' });
    store.close();
  });

  it('records a durable "submitted" activity with the Principal and device (AC2)', async () => {
    const { store, repository, engine } = setUp();
    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), collaboratorActor(repository));
    expect(engine.listActivity(run.id)).toEqual([{
      id: expect.any(String), runId: run.id, kind: 'submitted', at: expect.any(String),
      principal: { id: 'collab-1', displayName: 'Alice' }, device: { id: 'device-1', label: "Alice's phone" },
    }]);
    store.close();
  });

  it('refuses an ungranted Repository with a PolicyDeniedError and creates no Run at all', async () => {
    const { store, repository, engine } = setUp();
    const actor: RunActor = { principal: { id: 'collab-1', displayName: 'Alice' }, grants: { repositoryIds: [], profileIds: [approvedProfile.id] } };

    await expect(engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), actor))
      .rejects.toThrow(PolicyDeniedError);
    expect(engine.list()).toEqual([]);
    store.close();
  });

  it('refuses with no profileId at all (AC4: cannot select an unapproved runtime)', async () => {
    const { store, repository, engine } = setUp();
    const spec = { ...collaboratorRequestedSpec(repository, approvedProfile.id), profileId: undefined };
    const error = await engine.submit(spec, collaboratorActor(repository)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).rule).toBe('profile-required');
    store.close();
  });

  it('refuses an ungranted Profile even when the Repository is granted', async () => {
    const { store, repository, engine } = setUp();
    const error = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), collaboratorActor(repository, false))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).rule).toBe('profile-not-granted');
    store.close();
  });

  it('refuses a profileId that is granted but names no actual Profile', async () => {
    const { store, repository, engine } = setUp();
    const actor: RunActor = { principal: { id: 'collab-1', displayName: 'Alice' }, grants: { repositoryIds: [repository.id], profileIds: ['profile-9'] } };
    await expect(engine.submit(collaboratorRequestedSpec(repository, 'profile-9'), actor))
      .rejects.toThrow(/no such Profile/);
    store.close();
  });

  it('an admin (no actor) submission is completely unaffected — no Profile required, spec fields trusted as-is', async () => {
    const { store, repository, engine } = setUp();
    const spec = collaboratorRequestedSpec(repository, approvedProfile.id);
    spec.profileId = undefined;
    const run = await engine.submit(spec);
    expect(run.spec.runtimePreference).toEqual(['claude']); // the caller's own value, untouched
    store.close();
  });
});

describe('DurableWorkEngine guide actions with a collaborator RunActor (ticket 12 AC1/AC2/AC7)', () => {
  it('refuses prepare/cancel for a Run whose Repository is not granted to this actor, leaving it untouched', async () => {
    const { store, repository, engine } = setUp();
    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), collaboratorActor(repository));
    const outsideActor: RunActor = { principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } };

    await expect(engine.prepare(run.id, outsideActor)).rejects.toThrow(PolicyDeniedError);
    expect(engine.get(run.id)?.status).toBe('queued'); // untouched

    await expect(engine.cancel(run.id, outsideActor)).rejects.toThrow(PolicyDeniedError);
    expect(engine.get(run.id)?.status).toBe('queued');
    store.close();
  });

  it('a granted collaborator can prepare and cancel their own Run, and cancellation is durably attributed (AC2)', async () => {
    const { store, repository, engine } = setUp();
    const actor = collaboratorActor(repository);
    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), actor);

    await engine.prepare(run.id, actor);
    expect(engine.get(run.id)?.preparation.state).toBe('ready');

    const cancelled = await engine.cancel(run.id, actor);
    expect(cancelled.status).toBe('cancelled');
    const kinds = engine.listActivity(run.id).map((a) => a.kind);
    expect(kinds).toEqual(['submitted', 'cancelled']);
    store.close();
  });

  it('refuses resolveAttention for an ungranted Repository before ever checking whether an attention request is pending', async () => {
    const { store, repository, engine } = setUp();
    // Never prepared or started — a queued Run has no pendingAttention at
    // all, so a policy denial here can only be explained by the guard
    // running before (not after) the RunAttentionNotPendingError path.
    const run = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), collaboratorActor(repository));
    const outsideActor: RunActor = { principal: { id: 'collab-2', displayName: 'Bob' }, grants: { repositoryIds: [], profileIds: [] } };

    await expect(engine.resolveAttention(run.id, 'whatever', { kind: 'approve' }, outsideActor))
      .rejects.toThrow(PolicyDeniedError);
    store.close();
  });

  it('a granted collaborator approving a pending attention request is recorded end to end: submitted then approved, correct Principal throughout (AC1/AC2)', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const { store, repository, engine } = setUp(fake.spawn);
    const actor = collaboratorActor(repository);

    const submitted = await engine.submit(collaboratorRequestedSpec(repository, approvedProfile.id), actor);
    await engine.prepare(submitted.id, actor);
    await engine.start(submitted.id, actor);

    await vi.waitUntil(() => engine.get(submitted.id)?.pendingAttention !== undefined);
    const pending = engine.get(submitted.id)!.pendingAttention!;

    const resolved = await engine.resolveAttention(submitted.id, pending.id, { kind: 'approve' }, actor);
    expect(resolved.pendingAttention).toBeUndefined();

    const activity = engine.listActivity(submitted.id);
    expect(activity.map((a) => a.kind)).toEqual(['submitted', 'approved']);
    expect(activity.every((a) => a.principal.id === 'collab-1' && a.device?.id === 'device-1')).toBe(true);

    // Let the background Attempt reach a terminal state before closing the
    // store — otherwise its still-in-flight completion write races the
    // store handle closing underneath it (same pattern engine.test.ts's own
    // resolveAttention suite uses).
    await vi.waitUntil(() => {
      const run = engine.get(submitted.id);
      return run !== undefined && run.attempt.state !== 'running' && run.attempt.state !== 'idle';
    });
    store.close();
  });
});
