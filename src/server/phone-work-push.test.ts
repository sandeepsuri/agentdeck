import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredSessionInteraction } from '../store/index.js';
import type { Session } from '../types.js';
import { watchWorkNeeds } from './phone-work-push.js';
import type { WorkState } from './phone-work.js';

const session: Session = {
  id: 'sess-1', origin: 'managed', agent: 'claude', cwd: '/repo/app', repoId: '/repo/app',
  startedAt: '2026-10-01T09:00:00.000Z', lastActivityAt: '2026-10-01T09:00:00.000Z', status: 'working', statusSource: 'hook',
};

function approval(id: string): StoredSessionInteraction {
  return {
    id, sessionId: 'sess-1', provider: 'claude', providerSessionId: 'p', providerRequestId: id, kind: 'approval',
    question: 'Bash', choices: [], allowsFreeText: false, requestedAt: '2026-10-01T09:01:00.000Z', status: 'pending',
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('watchWorkNeeds', () => {
  it('pushes once for each new decision, never for what was already waiting or an agent between turns', () => {
    vi.useFakeTimers();
    let pending = [approval('a')];
    let sessions: Session[] = [session];
    const state = (): WorkState => ({
      sessions, isLive: () => true, interactions: () => pending, events: [], runs: [], feedback: () => [],
    });
    const push = vi.fn();
    const stop = watchWorkNeeds({ state, push, intervalMs: 100 });

    vi.advanceTimersByTime(300);
    expect(push).not.toHaveBeenCalled();

    pending = [approval('a'), approval('b')];
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(300);
    expect(push).toHaveBeenCalledTimes(1);

    pending = [];
    sessions = [{ ...session, status: 'waiting_input' }];
    vi.advanceTimersByTime(300);
    expect(push).toHaveBeenCalledTimes(1);
    stop();
  });
});
