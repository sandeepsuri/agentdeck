import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import {
  INITIAL_HISTORY_WITNESS_STATE, RAIL_GRACE_PERIOD_MS,
  advanceHistoryWitnessState, isInHistory, splitSessionsForRail,
} from './history.js';

const base = {
  cwd: '/repos/alpha',
  startedAt: '2026-07-17T12:00:00.000Z',
  lastActivityAt: '2026-07-17T12:00:00.000Z',
  agent: 'claude',
  statusSource: 'output_heuristic',
} satisfies Partial<Session>;

function managed(id: string, status: Session['status'] = 'working', over: Partial<Session> = {}): Session {
  return { ...base, id, origin: 'managed', status, ...over } as Session;
}

function external(id: string, status: Session['status'] = 'exited'): Session {
  return { ...base, id, origin: 'external', status } as Session;
}

const NOW = new Date('2026-07-17T14:00:00.000Z').getTime();

describe('isInHistory', () => {
  it('is false for a live managed session', () => {
    expect(isInHistory(managed('a', 'working'), NOW, new Map())).toBe(false);
  });

  it('is false for an external session even when exited (history is managed-only)', () => {
    expect(isInHistory(external('a'), NOW, new Map())).toBe(false);
  });

  it('is true for an ended session with no witnessed transition (fresh load / restart)', () => {
    expect(isInHistory(managed('a', 'exited'), NOW, new Map())).toBe(true);
  });

  it('is false for an ended session witnessed within the last hour', () => {
    const witnessed = new Map([['a', NOW - RAIL_GRACE_PERIOD_MS / 2]]);
    expect(isInHistory(managed('a', 'exited'), NOW, witnessed)).toBe(false);
  });

  it('is true for an ended session witnessed over an hour ago', () => {
    const witnessed = new Map([['a', NOW - RAIL_GRACE_PERIOD_MS - 1]]);
    expect(isInHistory(managed('a', 'exited'), NOW, witnessed)).toBe(true);
  });

  it('is true exactly at the grace period boundary', () => {
    const witnessed = new Map([['a', NOW - RAIL_GRACE_PERIOD_MS]]);
    expect(isInHistory(managed('a', 'exited'), NOW, witnessed)).toBe(true);
  });
});

describe('advanceHistoryWitnessState', () => {
  it('records a witnessed-ended timestamp when a live session it has already seen transitions to ended', () => {
    const afterLive = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'working')], NOW);
    const afterEnded = advanceHistoryWitnessState(afterLive, [managed('a', 'exited')], NOW + 1000);
    expect(afterEnded.witnessedEndedAtById.get('a')).toBe(NOW + 1000);
  });

  it('does not record a witnessed transition for a session that is already ended the first time it is seen', () => {
    const state = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'exited')], NOW);
    expect(state.witnessedEndedAtById.has('a')).toBe(false);
  });

  it('does not overwrite an already-recorded witnessed-ended timestamp on later calls', () => {
    const afterLive = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'working')], NOW);
    const afterEnded = advanceHistoryWitnessState(afterLive, [managed('a', 'exited')], NOW + 1000);
    const later = advanceHistoryWitnessState(afterEnded, [managed('a', 'exited')], NOW + 5000);
    expect(later.witnessedEndedAtById.get('a')).toBe(NOW + 1000);
  });

  it('drops bookkeeping for a session id once it disappears from the sessions list', () => {
    const afterLive = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'working')], NOW);
    const afterEnded = advanceHistoryWitnessState(afterLive, [managed('a', 'exited')], NOW + 1000);
    const afterGone = advanceHistoryWitnessState(afterEnded, [], NOW + 2000);
    expect(afterGone.witnessedEndedAtById.has('a')).toBe(false);
    expect(afterGone.liveSeenIds.has('a')).toBe(false);
  });
});

describe('splitSessionsForRail', () => {
  it('keeps live and external sessions in the rail and puts a never-witnessed ended session in history', () => {
    const sessions = [managed('a', 'working'), external('b'), managed('c', 'exited')];
    const { rail, history } = splitSessionsForRail(sessions, NOW, new Map());
    expect(rail.map((session) => session.id)).toEqual(['a', 'b']);
    expect(history.map((session) => session.id)).toEqual(['c']);
  });

  it('simulates a full session lifecycle: witnessed end stays in rail, then ages into history after an hour', () => {
    // Session 'a' is live, then this client watches it end.
    let state = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'working')], NOW);
    state = advanceHistoryWitnessState(state, [managed('a', 'exited')], NOW + 1000);

    const justEnded = splitSessionsForRail([managed('a', 'exited')], NOW + 1000, state.witnessedEndedAtById);
    expect(justEnded.rail.map((session) => session.id)).toEqual(['a']);
    expect(justEnded.history).toEqual([]);

    const wellWithinGrace = splitSessionsForRail([managed('a', 'exited')], NOW + 1000 + RAIL_GRACE_PERIOD_MS / 2, state.witnessedEndedAtById);
    expect(wellWithinGrace.rail.map((session) => session.id)).toEqual(['a']);

    const afterGrace = splitSessionsForRail([managed('a', 'exited')], NOW + 1000 + RAIL_GRACE_PERIOD_MS + 1, state.witnessedEndedAtById);
    expect(afterGrace.rail).toEqual([]);
    expect(afterGrace.history.map((session) => session.id)).toEqual(['a']);
  });

  it('simulates a restart: a session already ended on first load goes straight to history, not the rail', () => {
    // Fresh client state, as if the browser (or the server) just restarted:
    // the client never observed 'a' as live.
    const state = advanceHistoryWitnessState(INITIAL_HISTORY_WITNESS_STATE, [managed('a', 'exited')], NOW);
    const { rail, history } = splitSessionsForRail([managed('a', 'exited')], NOW, state.witnessedEndedAtById);
    expect(rail).toEqual([]);
    expect(history.map((session) => session.id)).toEqual(['a']);
  });
});
