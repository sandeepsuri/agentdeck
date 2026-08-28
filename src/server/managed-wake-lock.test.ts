import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types.js';
import type { SessionManager } from '../sessions/manager.js';
import type { WakeLock } from './wake-lock.js';
import { coordinateManagedWakeLock } from './managed-wake-lock.js';

describe('coordinateManagedWakeLock', () => {
  it('tracks live managed sessions, ignores external sessions, and releases cleanly', () => {
    const events = new EventEmitter();
    let sessions: Session[] = [];
    const manager = Object.assign(events, { listSessions: () => sessions }) as unknown as SessionManager;
    const update = vi.fn();
    const release = vi.fn();
    const stop = coordinateManagedWakeLock(manager, { update, release } as unknown as WakeLock);
    expect(update).toHaveBeenLastCalledWith(0);

    sessions = [
      {
        id: 'external', origin: 'external', agent: 'claude', cwd: '/tmp', status: 'working',
        statusSource: 'cpu_heuristic', startedAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T00:00:00.000Z',
      },
      {
        id: 'managed', origin: 'managed', agent: 'claude', cwd: '/tmp', status: 'working',
        statusSource: 'output_heuristic', startedAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T00:00:00.000Z',
      },
    ];
    events.emit('session_update', sessions[1]);
    expect(update).toHaveBeenLastCalledWith(1);

    stop();
    expect(release).toHaveBeenCalledOnce();
    events.emit('session_removed', 'managed');
    expect(update).toHaveBeenCalledTimes(2);
  });
});
