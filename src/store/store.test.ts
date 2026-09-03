import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, Repo, Session, Task } from '../types.js';
import { buildAttemptEventEnvelope } from '../work-engine/durable-events.js';
import type {
  AttemptEvent, Profile, RunPublication, RunRepository, WorkSpec,
} from '../work-engine/types.js';
import { Store, openStore } from './index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-store-'));
  store = openStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const managedSession: Session = {
  id: 'c0ffee00-1111-2222-3333-444455556666',
  origin: 'managed',
  agent: 'claude',
  name: 'FE-5 helper',
  cwd: '/tmp/repo',
  repoId: 'repo-1',
  branch: 'main',
  pid: 4711,
  startedAt: '2026-07-17T10:00:00.000Z',
  lastActivityAt: '2026-07-17T10:05:00.000Z',
  status: 'working',
  statusSource: 'output_heuristic',
  backend: 'pty',
  launchSpec: { agent: 'claude', cwd: '/tmp/repo', initialPrompt: 'hi', env: { A: 'b' } },
};

const externalSession: Session = {
  id: 'ext-4711-1721200000',
  origin: 'external',
  agent: 'codex',
  cwd: '/tmp/other',
  startedAt: '2026-07-17T09:00:00.000Z',
  lastActivityAt: '2026-07-17T09:00:00.000Z',
  status: 'idle',
  statusSource: 'cpu_heuristic',
  tty: 'ttys008',
  terminalApp: 'Terminal',
  terminalRef: { windowId: '58250', tabId: '1' },
  agentSessionId: 'codex:thread-123',
};

describe('sessions', () => {
  it('creates database files readable only by the current OS user', () => {
    const mode = fs.statSync(path.join(dir, 'agentdeck.db')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips a managed session including nested launchSpec', () => {
    store.upsertSession(managedSession);
    expect(store.getSession(managedSession.id)).toEqual(managedSession);
  });

  it('round-trips an external session including terminalRef', () => {
    store.upsertSession(externalSession);
    expect(store.getSession(externalSession.id)).toEqual(externalSession);
  });

  it('upsert updates in place (label persistence for ext-pid-start keys)', () => {
    store.upsertSession(externalSession);
    store.upsertSession({ ...externalSession, name: 'my label', status: 'working' });
    const got = store.getSession(externalSession.id);
    expect(got?.name).toBe('my label');
    expect(got?.status).toBe('working');
    expect(store.listSessions()).toHaveLength(1);
  });

  it('lists newest-started first and deletes', () => {
    store.upsertSession(managedSession);
    store.upsertSession(externalSession);
    expect(store.listSessions().map((s) => s.id)).toEqual([managedSession.id, externalSession.id]);
    store.deleteSession(managedSession.id);
    expect(store.listSessions().map((s) => s.id)).toEqual([externalSession.id]);
  });

  it('round-trips endedAt for an ended managed session (ticket 04)', () => {
    const ended: Session = {
      ...managedSession,
      status: 'exited',
      statusSource: 'process_gone',
      endedAt: '2026-07-17T11:00:00.000Z',
    };
    store.upsertSession(ended);
    expect(store.getSession(ended.id)).toEqual(ended);
  });

  it('omits endedAt for a session that has not ended', () => {
    store.upsertSession(managedSession);
    expect(store.getSession(managedSession.id)?.endedAt).toBeUndefined();
  });

  it('round-trips summaryGeneratedAt (ticket 11) — the summary text itself lives in a file, not this column', () => {
    const summarized: Session = {
      ...managedSession,
      status: 'exited',
      statusSource: 'process_gone',
      endedAt: '2026-07-17T11:00:00.000Z',
      summaryGeneratedAt: '2026-07-17T11:05:00.000Z',
    };
    store.upsertSession(summarized);
    expect(store.getSession(summarized.id)).toEqual(summarized);
  });

  it('omits summaryGeneratedAt until a summary has been generated', () => {
    store.upsertSession(managedSession);
    expect(store.getSession(managedSession.id)?.summaryGeneratedAt).toBeUndefined();
  });

  it('regenerating a summary updates summaryGeneratedAt in place', () => {
    const summarized: Session = { ...managedSession, summaryGeneratedAt: '2026-07-17T11:05:00.000Z' };
    store.upsertSession(summarized);
    store.upsertSession({ ...summarized, summaryGeneratedAt: '2026-07-17T12:00:00.000Z' });
    expect(store.getSession(summarized.id)?.summaryGeneratedAt).toBe('2026-07-17T12:00:00.000Z');
    expect(store.listSessions()).toHaveLength(1);
  });
});

describe('tasks', () => {
  it('round-trips and updates', () => {
    const task: Task = {
      id: 'FE-5',
      title: 'rebuild dashboard',
      repoId: 'repo-1',
      status: 'in_progress',
      dependsOn: ['FE-4'],
      sessionIds: [managedSession.id],
    };
    store.saveTask(task);
    expect(store.getTask('FE-5')).toEqual(task);
    store.saveTask({ ...task, status: 'done' });
    expect(store.getTask('FE-5')?.status).toBe('done');
    expect(store.listTasks()).toHaveLength(1);
  });
});

describe('repos', () => {
  it('round-trips including worktrees and dirty flags', () => {
    const repo: Repo = {
      id: 'repo-1',
      path: '/Users/dev/projects/example-admin',
      name: 'example-admin',
      currentBranch: 'feat/ui-redesign',
      isDirty: true,
      dirtyFiles: ['.gitignore'],
      worktrees: [{ path: '/tmp/wt', branch: 'fix/x' }],
    };
    store.upsertRepo(repo);
    expect(store.listRepos()).toEqual([repo]);
    store.upsertRepo({ ...repo, isDirty: false, dirtyFiles: [] });
    expect(store.listRepos()[0]?.isDirty).toBe(false);
  });
});

describe('durable Attempt events (ticket 06)', () => {
  const repository: RunRepository = { id: 'repo-1', name: 'example-admin', path: '/Users/dev/projects/example-admin' };
  const spec: WorkSpec = {
    objective: 'Add durable managed work',
    acceptanceCriteria: ['Restart keeps identity'],
    repository,
    requestedBaseReference: 'refs/heads/main',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 3_600_000 },
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'working-tree',
  };

  function createRun(runId: string) {
    store.upsertRepo(repository);
    store.createTaskAndRun(
      { id: `task-${runId}`, title: spec.objective, status: 'todo', sessionIds: [] },
      {
        id: runId,
        taskId: `task-${runId}`,
        status: 'queued',
        spec,
        submittedAt: '2026-09-01T00:00:00.000Z',
        principal: { id: 'local:test', displayName: 'test' },
        preparation: { state: 'pending' },
        envelope: { state: 'pending' },
        verificationPolicy: { state: 'pending' },
        attempt: { state: 'idle' },
      },
    );
  }

  it('projects idle with no attempts row', () => {
    createRun('run-1');
    expect(store.getRun('run-1')?.attempt).toEqual({ state: 'idle' });
    expect(store.getRun('run-1')?.status).toBe('queued');
  });

  it('folds a durable event log into a running Attempt, and derives status from it', () => {
    createRun('run-2');
    store.startAttempt({
      id: 'attempt-1', runId: 'run-2', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    const event: AttemptEvent = {
      kind: 'message', sequence: 0, at: '2026-09-01T00:05:01.000Z', role: 'assistant', text: 'Working on it.',
    };
    store.appendAttemptEvent(buildAttemptEventEnvelope({ runId: 'run-2', attemptId: 'attempt-1', event }));

    const run = store.getRun('run-2')!;
    expect(run.status).toBe('running');
    expect(run.attempt).toEqual({
      state: 'running', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z', events: [event],
    });
  });

  it('derives verifying (not completed) from a bare completion event — verification (ticket 08) has not concluded yet', () => {
    createRun('run-3');
    // No updateRun('running'/'completed') call ever happens here — the raw
    // column stays exactly 'queued' from createRun, exactly as a crash
    // right after the completion event persisted would leave it.
    store.startAttempt({
      id: 'attempt-1', runId: 'run-3', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-3',
      attemptId: 'attempt-1',
      event: {
        kind: 'completion', sequence: 0, at: '2026-09-01T00:06:00.000Z', outcome: 'success',
      },
    }));

    expect(store.getRun('run-3')?.status).toBe('verifying');
  });

  it('derives status from a verification-outcome event even though the raw runs.status column was never separately written', () => {
    createRun('run-3b');
    store.startAttempt({
      id: 'attempt-1', runId: 'run-3b', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-3b',
      attemptId: 'attempt-1',
      event: {
        kind: 'completion', sequence: 0, at: '2026-09-01T00:06:00.000Z', outcome: 'success',
      },
    }));
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-3b',
      attemptId: 'attempt-1',
      event: {
        kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:06:05.000Z', outcome: 'verified', repairAttempts: 0,
      },
    }));

    expect(store.getRun('run-3b')?.status).toBe('completed');
  });

  it('is idempotent: appending the same logical event twice never duplicates durable history', () => {
    createRun('run-4');
    store.startAttempt({
      id: 'attempt-1', runId: 'run-4', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    const event: AttemptEvent = {
      kind: 'usage', sequence: 0, at: '2026-09-01T00:05:01.000Z', inputTokens: 100, outputTokens: 50,
    };
    const envelope = buildAttemptEventEnvelope({ runId: 'run-4', attemptId: 'attempt-1', event });

    store.appendAttemptEvent(envelope);
    // A redelivered notification after a reconnect reproduces the same
    // content but a fresh sequence/timestamp — still the same dedupeKey.
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-4', attemptId: 'attempt-1', event: { ...event, sequence: 7, at: '2026-09-01T00:09:00.000Z' },
    }));

    const run = store.getRun('run-4')!;
    if (run.attempt.state === 'idle') throw new Error('expected a started Attempt');
    expect(run.attempt.events).toHaveLength(1);
    expect(run.attempt.events[0]).toEqual(event);
  });

  it('persists only the shared AttemptEvent shape — no extra property survives the JSON round trip', () => {
    createRun('run-5');
    store.startAttempt({
      id: 'attempt-1', runId: 'run-5', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    const event = {
      kind: 'message', sequence: 0, at: '2026-09-01T00:05:01.000Z', role: 'assistant', text: 'hi',
      // A hypothetical leaked provider/credential field — must not survive.
      threadId: 'thread-should-never-persist', apiKey: 'sk-should-never-persist',
    } as unknown as AttemptEvent;
    store.appendAttemptEvent(buildAttemptEventEnvelope({ runId: 'run-5', attemptId: 'attempt-1', event }));

    const run = store.getRun('run-5')!;
    expect(JSON.stringify(run)).not.toContain('should-never-persist');
  });

  it('reopens a Run\'s full durable Attempt history after the store restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-store-attempts-'));
    const dbPath = path.join(dir, 'agentdeck.db');
    const firstStore = openStore(dir);
    firstStore.upsertRepo(repository);
    firstStore.createTaskAndRun(
      { id: 'task-run-6', title: spec.objective, status: 'todo', sessionIds: [] },
      {
        id: 'run-6',
        taskId: 'task-run-6',
        status: 'queued',
        spec,
        submittedAt: '2026-09-01T00:00:00.000Z',
        principal: { id: 'local:test', displayName: 'test' },
        preparation: { state: 'pending' },
        envelope: { state: 'pending' },
        verificationPolicy: { state: 'pending' },
        attempt: { state: 'idle' },
      },
    );
    firstStore.startAttempt({
      id: 'attempt-1', runId: 'run-6', runtime: 'codex', startedAt: '2026-09-01T00:05:00.000Z',
    });
    firstStore.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-6',
      attemptId: 'attempt-1',
      event: {
        kind: 'completion', sequence: 0, at: '2026-09-01T00:06:00.000Z', outcome: 'success',
      },
    }));
    firstStore.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: 'run-6',
      attemptId: 'attempt-1',
      event: {
        kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:06:05.000Z', outcome: 'verified', repairAttempts: 0,
      },
    }));
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = reopenedStore.getRun('run-6')!;
    expect(reopened.status).toBe('completed');
    expect(reopened.attempt.state).toBe('completed');
    reopenedStore.close();
  });
});

describe('events', () => {
  const msg = (over: Partial<AgentMessage>): AgentMessage => ({
    ts: '2026-07-17T10:00:00.000Z',
    agent: 'claude:sess-abc',
    repo: 'example-admin',
    event: 'claim',
    files: ['src/a.ts'],
    ...over,
  });

  it('appends and lists chronologically with filters', () => {
    store.appendEvent(msg({ ts: '2026-07-17T10:00:00.000Z' }));
    store.appendEvent(msg({ ts: '2026-07-17T10:01:00.000Z', event: 'release' }));
    store.appendEvent(msg({ repo: 'other-repo', event: 'done' }));
    expect(store.listEvents()).toHaveLength(3);
    const forRepo = store.listEvents({ repo: 'example-admin' });
    expect(forRepo.map((e) => e.event)).toEqual(['claim', 'release']);
    expect(forRepo[0]?.files).toEqual(['src/a.ts']);
  });

  it('respects limit (most recent kept, chronological order)', () => {
    for (let i = 0; i < 5; i++) store.appendEvent(msg({ ts: `2026-07-17T10:0${i}:00.000Z` }));
    const last2 = store.listEvents({ limit: 2 });
    expect(last2.map((e) => e.ts)).toEqual(['2026-07-17T10:03:00.000Z', '2026-07-17T10:04:00.000Z']);
  });
});

describe('settings', () => {
  it('round-trips arbitrary JSON values', () => {
    expect(store.getSetting('missing')).toBeUndefined();
    store.setSetting('ui', { groupBy: 'repo', filters: ['claude'] });
    expect(store.getSetting('ui')).toEqual({ groupBy: 'repo', filters: ['claude'] });
    store.setSetting('ui', false);
    expect(store.getSetting('ui')).toBe(false);
  });
});

describe('collaborators (ticket 11)', () => {
  it('round-trips a collaborator and its granted repositories', () => {
    store.createCollaborator({ id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: [] });
    expect(store.getCollaborator('collab-1')).toEqual({
      id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z',
      grantedRepositoryIds: ['repo-1'], grantedProfileIds: [],
    });
    expect(store.listCollaborators()).toHaveLength(1);
    store.updateCollaboratorGrants('collab-1', { repositoryIds: ['repo-1', 'repo-2'], profileIds: ['profile-1'] });
    expect(store.getCollaborator('collab-1')?.grantedRepositoryIds).toEqual(['repo-1', 'repo-2']);
    expect(store.getCollaborator('collab-1')?.grantedProfileIds).toEqual(['profile-1']);
  });

  it('looks an invitation up by its code hash, never by id, and records consumption', () => {
    store.createCollaborator({ id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] });
    store.createInvitation(
      { id: 'inv-1', collaboratorId: 'collab-1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
      'a-code-hash',
    );
    expect(store.getInvitationByCodeHash('a-code-hash')).toEqual({
      id: 'inv-1', collaboratorId: 'collab-1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    });
    expect(store.getInvitationByCodeHash('no-such-hash')).toBeUndefined();
    store.consumeInvitation('inv-1', '2026-01-01T01:00:00.000Z');
    expect(store.getInvitationByCodeHash('a-code-hash')?.consumedAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('looks a device up by its token hash and lists devices scoped to one collaborator', () => {
    store.createCollaborator({ id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] });
    store.createCollaborator({ id: 'collab-2', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] });
    store.createDevice({ id: 'device-1', collaboratorId: 'collab-1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z' }, 'hash-1');
    store.createDevice({ id: 'device-2', collaboratorId: 'collab-2', deviceLabel: 'laptop', createdAt: '2026-01-01T00:00:00.000Z' }, 'hash-2');

    expect(store.getDeviceByTokenHash('hash-1')?.id).toBe('device-1');
    expect(store.getDeviceByTokenHash('no-such-hash')).toBeUndefined();
    expect(store.listDevices('collab-1')).toEqual([
      { id: 'device-1', collaboratorId: 'collab-1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(store.listDevices()).toHaveLength(2);
  });

  it('revoking a device is visible by id and by token hash, and does not touch other devices', () => {
    store.createCollaborator({ id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] });
    store.createDevice({ id: 'device-1', collaboratorId: 'collab-1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z' }, 'hash-1');
    store.createDevice({ id: 'device-2', collaboratorId: 'collab-1', deviceLabel: 'laptop', createdAt: '2026-01-01T00:00:00.000Z' }, 'hash-2');

    store.revokeDevice('device-1', '2026-01-01T02:00:00.000Z');

    expect(store.getDevice('device-1')?.revokedAt).toBe('2026-01-01T02:00:00.000Z');
    expect(store.getDeviceByTokenHash('hash-1')?.revokedAt).toBe('2026-01-01T02:00:00.000Z');
    expect(store.getDevice('device-2')?.revokedAt).toBeUndefined();
  });

  it('survives a restart: collaborators, invitations, and devices are reopened with the same identity', () => {
    store.createCollaborator({ id: 'collab-1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: [] });
    store.createInvitation(
      { id: 'inv-1', collaboratorId: 'collab-1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
      'a-code-hash',
    );
    store.createDevice({ id: 'device-1', collaboratorId: 'collab-1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z' }, 'a-token-hash');
    store.close();

    const reopened = openStore(dir);
    expect(reopened.getCollaborator('collab-1')?.grantedRepositoryIds).toEqual(['repo-1']);
    expect(reopened.getInvitationByCodeHash('a-code-hash')?.id).toBe('inv-1');
    expect(reopened.getDeviceByTokenHash('a-token-hash')?.id).toBe('device-1');
    reopened.close();
    store = openStore(dir); // hand back to afterEach
  });
});

describe('profiles (ticket 12)', () => {
  const profile: Profile = {
    id: 'profile-1',
    name: 'Standard Codex run',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 900_000, maxModelTurns: 25 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'local-commit',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips a Profile exactly, including its nested budget and verification intent', () => {
    store.createProfile(profile);
    expect(store.getProfile('profile-1')).toEqual(profile);
    expect(store.getProfile('no-such-profile')).toBeUndefined();
    expect(store.listProfiles()).toEqual([profile]);
  });

  it('survives a restart with the same identity', () => {
    store.createProfile(profile);
    store.close();
    const reopened = openStore(dir);
    expect(reopened.getProfile('profile-1')).toEqual(profile);
    reopened.close();
    store = openStore(dir); // hand back to afterEach
  });
});

describe('Run activity (ticket 12 AC2)', () => {
  const repository: RunRepository = { id: 'repo-1', name: 'example-admin', path: '/Users/dev/projects/example-admin' };
  const spec: WorkSpec = {
    objective: 'Add durable managed work',
    acceptanceCriteria: ['Restart keeps identity'],
    repository,
    requestedBaseReference: 'refs/heads/main',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 3_600_000 },
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'working-tree',
  };

  function createRun(runId: string) {
    store.upsertRepo(repository);
    store.createTaskAndRun(
      { id: `task-${runId}`, title: spec.objective, status: 'todo', sessionIds: [] },
      {
        id: runId, taskId: `task-${runId}`, status: 'queued', spec, submittedAt: '2026-09-01T00:00:00.000Z',
        principal: { id: 'local:test', displayName: 'test' },
        preparation: { state: 'pending' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
        attempt: { state: 'idle' },
      },
    );
  }

  it('appends activity in chronological order, scoped to one Run', () => {
    createRun('run-1');
    createRun('run-2');
    store.appendRunActivity({
      id: 'act-1', runId: 'run-1', kind: 'submitted',
      principal: { id: 'collab-1', displayName: 'Alice' }, device: { id: 'device-1', label: 'phone' },
      at: '2026-01-01T00:00:00.000Z',
    });
    store.appendRunActivity({
      id: 'act-2', runId: 'run-1', kind: 'approved',
      principal: { id: 'local:admin', displayName: 'admin' },
      at: '2026-01-01T00:01:00.000Z',
    });
    store.appendRunActivity({
      id: 'act-3', runId: 'run-2', kind: 'submitted',
      principal: { id: 'local:admin', displayName: 'admin' }, at: '2026-01-01T00:02:00.000Z',
    });

    const activity = store.listRunActivity('run-1');
    expect(activity.map((a) => a.id)).toEqual(['act-1', 'act-2']);
    expect(activity[0]).toEqual({
      id: 'act-1', runId: 'run-1', kind: 'submitted',
      principal: { id: 'collab-1', displayName: 'Alice' }, device: { id: 'device-1', label: 'phone' },
      at: '2026-01-01T00:00:00.000Z',
    });
    // No `device` key at all for the local admin's own action — omitted, not null.
    expect(activity[1]).not.toHaveProperty('device');
  });

  it('returns an empty list for a Run with no recorded activity', () => {
    expect(store.listRunActivity('no-such-run')).toEqual([]);
  });
});

describe('migrations', () => {
  it('boot is idempotent: reopening the same file re-runs migrate harmlessly', () => {
    store.upsertSession(externalSession);
    store.close();
    const again = openStore(dir); // second boot on same DB
    expect(again.getSession(externalSession.id)).toEqual(externalSession);
    expect(again.listSessions()).toHaveLength(1);
    again.close();
    store = openStore(dir); // hand back to afterEach
  });
});

describe('Run publications (ticket 13)', () => {
  const repository: RunRepository = { id: 'repo-1', name: 'example-admin', path: '/Users/dev/projects/example-admin' };

  function createRun(runId: string) {
    store.upsertRepo(repository);
    store.createTaskAndRun(
      { id: `task-${runId}`, title: 'Publish me', status: 'todo', sessionIds: [] },
      {
        id: runId,
        taskId: `task-${runId}`,
        status: 'queued',
        spec: {
          objective: 'Publish me',
          acceptanceCriteria: ['It is published'],
          repository,
          requestedBaseReference: 'main',
          runtimePreference: ['codex'],
          budget: {},
          verificationIntent: { required: false, commands: [] },
          requestedDeliveryResult: 'pull-request',
        },
        submittedAt: '2026-09-01T00:00:00.000Z',
        principal: { id: 'local:test', displayName: 'test' },
        preparation: { state: 'pending' },
        envelope: { state: 'pending' },
        verificationPolicy: { state: 'pending' },
        attempt: { state: 'idle' },
      },
    );
  }

  function publication(runId: string): RunPublication {
    return {
      id: `pub-${runId}`,
      runId,
      idempotencyKey: `run:${runId}:commit:abc123`,
      target: 'draft-pull-request',
      commit: 'abc123',
      branch: `agentdeck/run/${runId}`,
      state: 'authorized',
      authorizedBy: { id: 'local:admin', displayName: 'admin' },
      authorizedAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      executions: 0,
    };
  }

  it('reads no publication for a Run that never had one authorized', () => {
    createRun('run-1');
    expect(store.getRun('run-1')?.publication).toBeUndefined();
    expect(store.getRunPublication('run-1')).toBeUndefined();
  });

  it('round-trips an authorized intent and folds it onto the Run on every read', () => {
    createRun('run-1');
    store.createRunPublication(publication('run-1'));
    expect(store.getRunPublication('run-1')).toEqual(publication('run-1'));
    expect(store.getRun('run-1')?.publication).toEqual(publication('run-1'));
    expect(store.listRuns()[0]?.publication).toEqual(publication('run-1'));
  });

  it('refuses a second intent for the same Run — one stable identity per Run (AC3)', () => {
    createRun('run-1');
    store.createRunPublication(publication('run-1'));
    expect(() => store.createRunPublication({ ...publication('run-1'), id: 'pub-other' })).toThrow();
  });

  it('updates state, executions, result, and reason in place, omitting absent optionals on read', () => {
    createRun('run-1');
    store.createRunPublication(publication('run-1'));
    store.updateRunPublication({
      ...publication('run-1'), state: 'executing', executions: 1, updatedAt: '2026-09-02T00:00:01.000Z',
    });
    expect(store.getRunPublication('run-1')).toMatchObject({ state: 'executing', executions: 1 });
    expect(store.getRunPublication('run-1')).not.toHaveProperty('result');
    expect(store.getRunPublication('run-1')).not.toHaveProperty('reason');

    const result = {
      remote: { name: 'origin' as const, url: 'git@github.com:example/project.git' },
      branch: 'agentdeck/run/run-1',
      commit: 'abc123',
      pullRequest: { number: 7, url: 'https://github.com/example/project/pull/7', title: 'Publish me', draft: true },
    };
    store.updateRunPublication({
      ...publication('run-1'), state: 'succeeded', executions: 1, updatedAt: '2026-09-02T00:00:02.000Z', result,
    });
    expect(store.getRunPublication('run-1')).toMatchObject({ state: 'succeeded', result });

    store.updateRunPublication({
      ...publication('run-1'), state: 'ambiguous', executions: 2, updatedAt: '2026-09-02T00:00:03.000Z', reason: 'origin unreachable',
    });
    expect(store.getRunPublication('run-1')).toMatchObject({ state: 'ambiguous', reason: 'origin unreachable' });
    expect(store.getRunPublication('run-1')).not.toHaveProperty('result');
  });

  it('lists only incomplete intents (authorized or executing) for restart reconciliation (AC5)', () => {
    for (const runId of ['run-a', 'run-b', 'run-c', 'run-d', 'run-e']) createRun(runId);
    store.createRunPublication(publication('run-a'));
    store.createRunPublication({ ...publication('run-b'), id: 'pub-b', idempotencyKey: 'run:run-b:commit:abc', state: 'executing' });
    store.createRunPublication({ ...publication('run-c'), id: 'pub-c', idempotencyKey: 'run:run-c:commit:abc', state: 'succeeded' });
    store.createRunPublication({ ...publication('run-d'), id: 'pub-d', idempotencyKey: 'run:run-d:commit:abc', state: 'failed' });
    store.createRunPublication({ ...publication('run-e'), id: 'pub-e', idempotencyKey: 'run:run-e:commit:abc', state: 'ambiguous' });
    expect(store.listIncompleteRunPublications().map((item) => item.runId).sort()).toEqual(['run-a', 'run-b']);
  });
});
