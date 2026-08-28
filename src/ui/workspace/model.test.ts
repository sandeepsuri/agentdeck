import { describe, expect, it } from 'vitest';
import type { Repo, Session } from '../../types.js';
import { isEndedSession, repoDisplayName } from './model.js';

const base = {
  cwd: '/repos/alpha',
  startedAt: '2026-07-17T12:00:00.000Z',
  lastActivityAt: '2026-07-17T12:00:00.000Z',
  agent: 'claude',
  statusSource: 'output_heuristic',
} satisfies Partial<Session>;

function managed(status: Session['status'], over: Partial<Session> = {}): Session {
  return { ...base, id: 'a', origin: 'managed', status, ...over } as Session;
}

function external(status: Session['status']): Session {
  return { ...base, id: 'a', origin: 'external', status } as Session;
}

describe('isEndedSession', () => {
  it('is true for a managed session whose process has exited', () => {
    expect(isEndedSession(managed('exited', { endedAt: '2026-07-17T12:05:00.000Z' }))).toBe(true);
  });

  it('is false for a live managed session (starting/working/idle/waiting_input)', () => {
    expect(isEndedSession(managed('starting'))).toBe(false);
    expect(isEndedSession(managed('working'))).toBe(false);
    expect(isEndedSession(managed('idle'))).toBe(false);
    expect(isEndedSession(managed('waiting_input'))).toBe(false);
  });

  it('is false for an external session even if its status is exited', () => {
    // "Ended" is a managed-session concept (spec non-goal: no history for
    // external sessions); external rows with a dead process disappear
    // entirely via DiscoveryPoller instead.
    expect(isEndedSession(external('exited'))).toBe(false);
  });
});

describe('repoDisplayName', () => {
  const repos: Repo[] = [{ id: '/repos/alpha', path: '/repos/alpha', name: 'alpha' }];

  it('resolves the repo name by matching repoId against the known repos list', () => {
    expect(repoDisplayName(managed('exited', { repoId: '/repos/alpha' }), repos)).toBe('alpha');
  });

  it('falls back to the cwd basename when no repo matches', () => {
    expect(repoDisplayName(managed('exited', { repoId: '/repos/unknown', cwd: '/repos/unknown' }), repos)).toBe('unknown');
  });
});
