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
      startedAt: '2026-07-17T12:00:00.000Z', lastActivityAt: '2026-07-17T12:00:00.000Z',
      status: 'idle', statusSource: 'cpu_heuristic',
    };
    store.upsertSession(session);
    const message: AgentMessage = {
      ts: new Date().toISOString(), agent: 'claude:captured-session', repo: repoPath,
      event: 'progress', task: 'T9', status: 'working', dependsOn: ['T8'],
    };
    await appendAgentMessage(repoPath, message);

    await coordination.syncRepos([{ id: repoPath, path: repoPath, name: 'repo' }]);

    expect(store.getSession(session.id)).toMatchObject({ taskId: 'T9', status: 'working', statusSource: 'hook' });
    expect(store.getTask('T9')).toEqual({
      id: 'T9', title: 'T9', repoId: repoPath, status: 'in_progress',
      dependsOn: ['T8'], sessionIds: [session.id],
    });
    coordination.stop();
    store.close();
  });
});
