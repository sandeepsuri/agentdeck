import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, Repo, Session, Task } from '../types.js';
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
