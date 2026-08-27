import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import { nextMountedTerminalIds, sameIds } from './terminalViews.js';

const base = {
  cwd: '/repos/alpha',
  startedAt: '2026-07-17T12:00:00.000Z',
  lastActivityAt: '2026-07-17T12:00:00.000Z',
  agent: 'claude',
  statusSource: 'output_heuristic',
} satisfies Partial<Session>;

function managed(id: string, status: Session['status'] = 'working'): Session {
  return { ...base, id, origin: 'managed', status } as Session;
}

function external(id: string, status: Session['status'] = 'working'): Session {
  return { ...base, id, origin: 'external', status } as Session;
}

describe('nextMountedTerminalIds', () => {
  it('mounts the selected managed session on first view', () => {
    const sessions = [managed('a')];
    expect(nextMountedTerminalIds([], sessions, 'a')).toEqual(['a']);
  });

  it('keeps a previously mounted session mounted when switching away', () => {
    const sessions = [managed('a'), managed('b')];
    expect(nextMountedTerminalIds(['a'], sessions, 'b')).toEqual(['a', 'b']);
  });

  it('does not duplicate an already-mounted selection', () => {
    const sessions = [managed('a'), managed('b')];
    expect(nextMountedTerminalIds(['a', 'b'], sessions, 'a')).toEqual(['a', 'b']);
  });

  it('does not mount an external session', () => {
    const sessions = [external('a')];
    expect(nextMountedTerminalIds([], sessions, 'a')).toEqual([]);
  });

  it('does not mount when nothing is selectable (ws not ready)', () => {
    const sessions = [managed('a')];
    expect(nextMountedTerminalIds([], sessions, null)).toEqual([]);
  });

  it('drops a mounted id once its session is removed from the list', () => {
    const sessions = [managed('b')];
    expect(nextMountedTerminalIds(['a', 'b'], sessions, 'b')).toEqual(['b']);
  });

  it('drops a mounted id once its session status is exited', () => {
    const sessions = [managed('a', 'exited'), managed('b')];
    expect(nextMountedTerminalIds(['a', 'b'], sessions, 'b')).toEqual(['b']);
  });

  it('prunes down to nothing when all mounted sessions are gone', () => {
    expect(nextMountedTerminalIds(['a', 'b'], [], null)).toEqual([]);
  });
});

describe('sameIds', () => {
  it('treats equal-order id lists as the same', () => {
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('treats different lengths as different', () => {
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
  });

  it('treats different order as different', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
