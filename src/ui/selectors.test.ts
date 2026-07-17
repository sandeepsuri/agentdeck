import { describe, expect, it } from 'vitest';
import type { Repo, Session } from '../types.js';
import { filterSessions, groupSessions, type SessionFilters } from './selectors.js';

const repos: Repo[] = [
  { id: '/repos/alpha', path: '/repos/alpha', name: 'alpha' },
  { id: '/repos/beta', path: '/repos/beta', name: 'beta' },
];

const base = {
  cwd: '/repos/alpha',
  startedAt: '2026-07-17T12:00:00.000Z',
  lastActivityAt: '2026-07-17T12:00:00.000Z',
} satisfies Partial<Session>;

const sessions: Session[] = [
  { ...base, id: 'one', origin: 'managed', agent: 'claude', repoId: '/repos/alpha', status: 'working', statusSource: 'output_heuristic' } as Session,
  { ...base, id: 'two', origin: 'external', agent: 'codex', repoId: '/repos/alpha', status: 'idle', statusSource: 'cpu_heuristic' } as Session,
  { ...base, id: 'three', origin: 'external', agent: 'claude', repoId: '/repos/beta', status: 'working', statusSource: 'cpu_heuristic' } as Session,
  { ...base, id: 'four', origin: 'managed', agent: 'codex', cwd: '/tmp', status: 'exited', statusSource: 'process_gone' } as Session,
];

describe('filterSessions', () => {
  it('combines repo, agent, status, and origin filters', () => {
    const filters: SessionFilters = {
      repo: '/repos/alpha',
      agent: 'codex',
      status: 'idle',
      origin: 'external',
    };
    expect(filterSessions(sessions, filters).map((session) => session.id)).toEqual(['two']);
  });

  it('treats empty filters as all and supports name/cwd text search', () => {
    expect(filterSessions(sessions, {})).toEqual(sessions);
    expect(filterSessions([{ ...sessions[0]!, name: 'Payments migration' }, ...sessions.slice(1)], { query: 'payments' }).map((session) => session.id)).toEqual(['one']);
    expect(filterSessions(sessions, { query: '/tmp' }).map((session) => session.id)).toEqual(['four']);
  });
});

describe('groupSessions', () => {
  it('groups by repo with friendly names and an unassigned bucket', () => {
    const groups = groupSessions(sessions, 'repo', repos);
    expect(groups.map((group) => [group.key, group.label, group.sessions.map((session) => session.id)])).toEqual([
      ['/repos/alpha', 'alpha', ['one', 'two']],
      ['/repos/beta', 'beta', ['three']],
      ['unassigned', 'No repository', ['four']],
    ]);
  });

  it('can group by agent, status, origin, or not at all', () => {
    expect(groupSessions(sessions, 'agent', repos).map((group) => group.key)).toEqual(['claude', 'codex']);
    expect(groupSessions(sessions, 'status', repos).map((group) => group.key)).toEqual(['working', 'idle', 'exited']);
    expect(groupSessions(sessions, 'origin', repos).map((group) => group.key)).toEqual(['managed', 'external']);
    expect(groupSessions(sessions, 'none', repos)).toEqual([{ key: 'all', label: 'All sessions', sessions }]);
  });
});
