import { describe, expect, it } from 'vitest';
import type { Repo, Session } from '../../types.js';
import { adminSessions, isEndedSession, repoDisplayName, sessionLabel } from './model.js';

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

// The reload crash: GET /api/sessions answers a collaborator device with the
// narrowed CollaboratorSession, and App fetches it before /api/connection has
// said which kind of device this is — so the desktop tree, which renders while
// that probe is in flight, was handed sessions with no `cwd` and threw on
// sessionLabel's `session.cwd.split('/')`.
describe('adminSessions', () => {
  const full: Session = { ...base, id: 'managed-1', cwd: '/Users/dev/projects/example' } as Session;
  /** Exactly the shape server/collaborator-session-view.ts produces. */
  const narrowed = {
    id: 'ext-4711-1', origin: 'external', agent: 'claude', repoId: '/Users/dev/projects/example',
    status: 'working', statusSource: 'hook',
    startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
  } as unknown as Session;

  it('keeps a Session the desktop views can actually read', () => {
    expect(adminSessions([full])).toEqual([full]);
  });

  it('drops a collaborator’s narrowed Session rather than letting it reach sessionLabel', () => {
    expect(adminSessions([narrowed])).toEqual([]);
    // The precondition this is protecting, stated outright.
    expect(() => sessionLabel(narrowed)).toThrow();
    expect(() => sessionLabel(full)).not.toThrow();
  });

  it('keeps the admin’s own sessions when both shapes somehow arrive together', () => {
    expect(adminSessions([narrowed, full]).map((session) => session.id)).toEqual(['managed-1']);
  });

  it('is empty, not broken, for a collaborator device', () => {
    expect(adminSessions([narrowed, { ...narrowed, id: 'ext-2' }])).toEqual([]);
  });
});
