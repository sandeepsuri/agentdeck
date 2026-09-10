// Ticket 68 (B13, docs/specs/run-execution-terminal-capabilities.md): a
// pure, derived (never stored) projection — no Store, no engine, so this
// is exercised as plain unit tests over fixture WorkRun/Session values.
import { describe, expect, it } from 'vitest';
import type { Session } from '../types.js';
import type { WorkRun } from './types.js';
import { deriveRunCompanionSessions } from './run-companion-session.js';

function baseRun(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: 'running',
    spec: {
      objective: 'Fix the flaky auth test',
      acceptanceCriteria: ['It passes'],
      repository: { id: 'repo-1', name: 'example', path: '/repos/example' },
      requestedBaseReference: 'main',
      runtimePreference: ['codex'],
      budget: {},
      verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: 'local-commit',
    },
    submittedAt: '2026-09-01T00:00:00.000Z',
    principal: { id: 'local:test', displayName: 'test' },
    preparation: { state: 'ready', worktreePath: '/repos/example-runs/run-1' },
    envelope: { state: 'pending' },
    verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    origin: 'managed',
    agent: 'codex',
    cwd: '/repos/example',
    startedAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    status: 'working',
    statusSource: 'hook',
    ...overrides,
  };
}

describe('deriveRunCompanionSessions', () => {
  it('returns nothing for a Run whose worktree is not prepared yet', () => {
    const run = baseRun({ preparation: { state: 'pending' } });
    const session = baseSession({ worktreePath: '/repos/example-runs/run-1' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([]);
  });

  it('returns nothing when no Session matches — the ordinary case', () => {
    const run = baseRun();
    const session = baseSession({ cwd: '/repos/unrelated', repoId: 'repo-2' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([]);
  });

  it('matches exactly on worktreePath', () => {
    const run = baseRun();
    const session = baseSession({ id: 'sess-a', worktreePath: '/repos/example-runs/run-1' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([
      { sessionId: 'sess-a', origin: 'managed', agent: 'codex', status: 'working', exactWorktreeMatch: true },
    ]);
  });

  it('matches exactly on cwd when worktreePath is absent (an external terminal cd\'d into the worktree)', () => {
    const run = baseRun();
    const session = baseSession({ id: 'sess-b', origin: 'external', cwd: '/repos/example-runs/run-1' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([
      { sessionId: 'sess-b', origin: 'external', agent: 'codex', status: 'working', exactWorktreeMatch: true },
    ]);
  });

  it('falls back to a same-Repository match, flagged as inexact', () => {
    const run = baseRun();
    const session = baseSession({ id: 'sess-c', cwd: '/repos/example', repoId: 'repo-1' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([
      { sessionId: 'sess-c', origin: 'managed', agent: 'codex', status: 'working', exactWorktreeMatch: false },
    ]);
  });

  it('returns every matching Session as its own row, never picking one', () => {
    const run = baseRun();
    const first = baseSession({ id: 'sess-1', worktreePath: '/repos/example-runs/run-1' });
    const second = baseSession({ id: 'sess-2', origin: 'external', worktreePath: '/repos/example-runs/run-1' });

    const result = deriveRunCompanionSessions(run, [first, second]);

    expect(result.map((row) => row.sessionId)).toEqual(['sess-1', 'sess-2']);
  });

  it('includes an ended Session rather than filtering it out', () => {
    const run = baseRun();
    const session = baseSession({ worktreePath: '/repos/example-runs/run-1', status: 'exited', endedAt: '2026-09-01T00:05:00.000Z' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([
      { sessionId: 'sess-1', origin: 'managed', agent: 'codex', status: 'exited', exactWorktreeMatch: true },
    ]);
  });

  it('never matches a Session from a different Run\'s worktree even in the same Repository directory tree', () => {
    const run = baseRun();
    const session = baseSession({ worktreePath: '/repos/example-runs/run-2' });

    expect(deriveRunCompanionSessions(run, [session])).toEqual([]);
  });
});
