import { describe, expect, it } from 'vitest';
import { deriveRunStatus, projectAttemptState } from './attempt-projection.js';
import type { AttemptEvent, AttemptState } from './types.js';

const record = { runtime: 'codex' as const, startedAt: '2026-09-01T00:00:00.000Z' };

describe('projectAttemptState', () => {
  it('projects idle when no Attempt record exists, regardless of any stray events', () => {
    expect(projectAttemptState(undefined, [])).toEqual({ state: 'idle' });
  });

  it('projects running with no events the instant an Attempt starts', () => {
    expect(projectAttemptState(record, [])).toEqual({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events: [],
    });
  });

  it('projects running while the trailing event is not yet terminal', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'tool-activity', sequence: 1, at: '2026-09-01T00:00:02.000Z', tool: 'command_execution', status: 'started' },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events,
    });
  });

  it('freezes completed from a trailing completion event', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success' },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'completed', runtime: 'codex', startedAt: record.startedAt, events, completedAt: '2026-09-01T00:01:00.000Z',
    });
  });

  it('freezes failed with the precise reason from a trailing failure event', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: '2026-09-01T00:01:00.000Z', reason: 'The sandboxed command exited non-zero.' },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'failed',
      runtime: 'codex',
      startedAt: record.startedAt,
      events,
      failedAt: '2026-09-01T00:01:00.000Z',
      reason: 'The sandboxed command exited non-zero.',
    });
  });

  it('is deterministic: the same record and events always fold to the same state', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'usage', sequence: 1, at: '2026-09-01T00:00:02.000Z', inputTokens: 100, outputTokens: 'unknown' },
    ];
    expect(projectAttemptState(record, events)).toEqual(projectAttemptState(record, [...events]));
  });
});

describe('deriveRunStatus', () => {
  const running: AttemptState = { state: 'running', runtime: 'codex', startedAt: record.startedAt, events: [] };
  const completed: AttemptState = {
    state: 'completed', runtime: 'codex', startedAt: record.startedAt, events: [], completedAt: '2026-09-01T00:01:00.000Z',
  };
  const failed: AttemptState = {
    state: 'failed', runtime: 'codex', startedAt: record.startedAt, events: [], failedAt: '2026-09-01T00:01:00.000Z', reason: 'boom',
  };
  const idle: AttemptState = { state: 'idle' };

  it('falls back to the raw status while the Attempt is idle', () => {
    expect(deriveRunStatus('preparing', idle)).toBe('preparing');
    expect(deriveRunStatus('queued', idle)).toBe('queued');
  });

  it('reports running once an Attempt has started, regardless of the raw status', () => {
    expect(deriveRunStatus('preparing', running)).toBe('running');
  });

  it('lets a cancellation surface while the Attempt is still running', () => {
    expect(deriveRunStatus('cancelled', running)).toBe('cancelled');
  });

  it('never hides a real terminal outcome behind a stale cancellation request that lost the race', () => {
    expect(deriveRunStatus('cancelled', completed)).toBe('completed');
    expect(deriveRunStatus('cancelled', failed)).toBe('failed');
  });

  it('always reports the Attempt\'s own terminal outcome once it has one', () => {
    expect(deriveRunStatus('running', completed)).toBe('completed');
    expect(deriveRunStatus('running', failed)).toBe('failed');
  });
});
