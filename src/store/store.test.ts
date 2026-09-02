import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, Repo, Session, Task } from '../types.js';
import { buildAttemptEventEnvelope } from '../work-engine/durable-events.js';
import type { AttemptEvent, RunRepository, WorkSpec } from '../work-engine/types.js';
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
