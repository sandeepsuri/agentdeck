// Ticket 04: on boot, no managed session's PTY survived the previous
// process — but ended sessions must survive the restart, not be deleted.
// This is the seam that used to live inline in startServer() as an
// unconditional "delete every managed row + every exited row" loop.
import { describe, expect, it } from 'vitest';
import type { Session } from '../types.js';
import { Store } from '../store/index.js';
import { reconcileSessionsOnBoot } from './boot.js';

function session(over: Partial<Session>): Session {
  return {
    id: 'sess-1', origin: 'managed', agent: 'claude', cwd: '/repo',
    startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
    status: 'working', statusSource: 'output_heuristic',
    ...over,
  };
}

describe('reconcileSessionsOnBoot', () => {
  it('marks a managed session that was live when the server died as exited, with an endedAt', () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'working' }));
    reconcileSessionsOnBoot(store);
    const row = store.getSession('a');
    expect(row?.status).toBe('exited');
    expect(row?.statusSource).toBe('process_gone');
    expect(row?.endedAt).toBeDefined();
    store.close();
  });

  it('keeps an already-ended managed session, without touching its original endedAt', () => {
    const store = new Store(':memory:');
    store.upsertSession(session({
      id: 'a', status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T08:00:00.000Z',
    }));
    reconcileSessionsOnBoot(store);
    expect(store.getSession('a')).toMatchObject({ status: 'exited', endedAt: '2026-08-27T08:00:00.000Z' });
    store.close();
  });

  it('never deletes a managed session row', () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'starting' }));
    reconcileSessionsOnBoot(store);
    expect(store.listSessions()).toHaveLength(1);
    store.close();
  });

  it('leaves external sessions alone entirely (discovery reconciles them on its own)', () => {
    const store = new Store(':memory:');
    store.upsertSession(session({
      id: 'ext-1', origin: 'external', status: 'idle', statusSource: 'cpu_heuristic',
    }));
    reconcileSessionsOnBoot(store);
    expect(store.getSession('ext-1')).toMatchObject({ status: 'idle' });
    store.close();
  });
});
