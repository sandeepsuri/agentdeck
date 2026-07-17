import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Handle, SessionBackend } from '../sessions/backend.js';
import { SessionManager } from '../sessions/manager.js';
import { Store } from '../store/index.js';
import type { AgentMessage, LaunchSpec, Session } from '../types.js';
import { appendAgentMessage } from './bus.js';
import { CoordinationService } from './service.js';

class UnusedBackend implements SessionBackend {
  async spawn(_spec: LaunchSpec): Promise<Handle> { throw new Error('unused'); }
  write(): void {}
  onData(): void {}
  onExit(): void {}
  resize(): void {}
  async kill(): Promise<void> {}
  async list(): Promise<Handle[]> { return []; }
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('CoordinationService', () => {
  it('associates task and hook status with the matching active session', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-coordination-'));
    dirs.push(repoPath);
    const store = new Store(':memory:');
    const manager = new SessionManager(new UnusedBackend(), store);
    const coordination = new CoordinationService(store, manager);
    const session: Session = {
      id: 'ext-12-34', origin: 'external', agent: 'claude', cwd: repoPath, repoId: repoPath,
      pid: 12, tty: 'ttys012',
      startedAt: '2026-07-17T12:00:00.000Z', lastActivityAt: '2026-07-17T12:00:00.000Z',
      status: 'idle', statusSource: 'cpu_heuristic',
    };
    store.upsertSession(session);
    const message: AgentMessage = {
      ts: new Date().toISOString(), agent: 'claude:captured-session', repo: repoPath,
      event: 'progress', task: 'T9', status: 'working', dependsOn: ['T8'], sourcePids: [99, 12],
    };
    await appendAgentMessage(repoPath, message);

    await coordination.syncRepos([{ id: repoPath, path: repoPath, name: 'repo' }]);

    expect(store.getSession(session.id)).toMatchObject({
      taskId: 'T9', status: 'working', statusSource: 'hook',
      agentSessionId: 'claude:captured-session',
    });
    expect(store.getTask('T9')).toEqual({
      id: 'T9', title: 'T9', repoId: repoPath, status: 'in_progress',
      dependsOn: ['T8'], sessionIds: [session.id],
    });
    coordination.stop();
    store.close();
  });

  it('does not guess when two same-repo sessions lack exact correlation', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-coordination-'));
    dirs.push(repoPath);
    const store = new Store(':memory:');
    const manager = new SessionManager(new UnusedBackend(), store);
    const coordination = new CoordinationService(store, manager);
    const base = {
      origin: 'external', agent: 'claude', cwd: repoPath, repoId: repoPath,
      startedAt: '2026-07-17T12:00:00.000Z', lastActivityAt: '2026-07-17T12:00:00.000Z',
      status: 'idle', statusSource: 'cpu_heuristic',
    } as const;
    store.upsertSession({ ...base, id: 'ext-1-1', pid: 1, tty: 'ttys001' });
    store.upsertSession({ ...base, id: 'ext-2-2', pid: 2, tty: 'ttys002' });
    await appendAgentMessage(repoPath, {
      ts: new Date().toISOString(), agent: 'claude:unassigned', repo: repoPath,
      event: 'status', status: 'working',
    });

    await coordination.syncRepos([{ id: repoPath, path: repoPath, name: 'repo' }]);

    expect(store.getSession('ext-1-1')?.agentSessionId).toBeUndefined();
    expect(store.getSession('ext-2-2')?.agentSessionId).toBeUndefined();
    expect(store.getSession('ext-1-1')?.status).toBe('idle');
    expect(store.getSession('ext-2-2')?.status).toBe('idle');
    coordination.stop();
    store.close();
  });

  it('reconciles a SessionStart event that arrives before process discovery', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-coordination-'));
    dirs.push(repoPath);
    const store = new Store(':memory:');
    const manager = new SessionManager(new UnusedBackend(), store);
    const coordination = new CoordinationService(store, manager);
    const eventAt = new Date().toISOString();
    await appendAgentMessage(repoPath, {
      ts: eventAt, agent: 'claude:early-hook', repo: repoPath,
      event: 'session_start', status: 'idle', sourcePids: [812], tty: 'ttys008',
    });
    await coordination.syncRepos([{ id: repoPath, path: repoPath, name: 'repo' }]);
    const session: Session = {
      id: 'ext-812-1', origin: 'external', agent: 'claude', cwd: repoPath, repoId: repoPath,
      pid: 812, tty: 'ttys008', startedAt: '2026-07-17T12:00:00.000Z',
      lastActivityAt: '2026-07-17T12:00:00.000Z', status: 'unknown', statusSource: 'cpu_heuristic',
    };
    store.upsertSession(session);

    coordination.reconcileSession(session);

    expect(store.getSession(session.id)).toMatchObject({
      agentSessionId: 'claude:early-hook', status: 'idle', statusSource: 'hook',
    });
    coordination.stop();
    store.close();
  });
});
