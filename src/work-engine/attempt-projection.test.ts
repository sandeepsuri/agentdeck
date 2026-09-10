import { describe, expect, it } from 'vitest';
import { deriveOpenAttentionRequest, deriveRunStatus, projectAttemptState } from './attempt-projection.js';
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

  it('reports running (not completed) from a trailing completion event with no verification-outcome yet (ticket 08: verification is still pending)', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success' },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events,
    });
  });

  it('reports running while a verification-check evidence event is the trailing event, mid repair cycle', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success' },
      {
        kind: 'verification-check', sequence: 2, at: '2026-09-01T00:01:01.000Z', gate: 'tests', command: 'npm test',
        required: true, passed: false, exitCode: 1, evidence: 'boom',
      },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events,
    });
  });

  it('freezes completed from a trailing verification-outcome event, using the last completion event\'s timestamp', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success' },
      {
        kind: 'verification-outcome', sequence: 2, at: '2026-09-01T00:01:05.000Z', outcome: 'verified', repairAttempts: 0,
      },
    ];
    expect(projectAttemptState(record, events)).toEqual({
      state: 'completed', runtime: 'codex', startedAt: record.startedAt, events, completedAt: '2026-09-01T00:01:00.000Z',
    });
  });

  it('uses the most recent completion event\'s timestamp when a repair round produced a second one', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success' },
      {
        kind: 'verification-check', sequence: 2, at: '2026-09-01T00:01:01.000Z', gate: 'tests', command: 'npm test',
        required: true, passed: false, exitCode: 1, evidence: 'boom',
      },
      { kind: 'lifecycle', sequence: 3, at: '2026-09-01T00:02:00.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 4, at: '2026-09-01T00:03:00.000Z', outcome: 'success' },
      {
        kind: 'verification-outcome', sequence: 5, at: '2026-09-01T00:03:05.000Z', outcome: 'verified', repairAttempts: 1,
      },
    ];
    expect(projectAttemptState(record, events)).toMatchObject({ state: 'completed', completedAt: '2026-09-01T00:03:00.000Z' });
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
  function completedWith(outcome: AttemptEvent & { kind: 'verification-outcome' }): AttemptState {
    return {
      state: 'completed', runtime: 'codex', startedAt: record.startedAt, events: [outcome], completedAt: '2026-09-01T00:01:00.000Z',
    };
  }
  const completed = completedWith({
    kind: 'verification-outcome', sequence: 0, at: '2026-09-01T00:01:05.000Z', outcome: 'verified', repairAttempts: 0,
  });
  const completedUnverified = completedWith({
    kind: 'verification-outcome', sequence: 0, at: '2026-09-01T00:01:05.000Z', outcome: 'unverified', repairAttempts: 0,
  });
  const failedVerification = completedWith({
    kind: 'verification-outcome', sequence: 0, at: '2026-09-01T00:01:05.000Z', outcome: 'failed_verification', repairAttempts: 2,
  });
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

  it('maps each verification outcome to its own distinct RunStatus (ticket 08 AC6/AC7)', () => {
    expect(deriveRunStatus('running', completed)).toBe('completed');
    expect(deriveRunStatus('running', completedUnverified)).toBe('completed_unverified');
    expect(deriveRunStatus('running', failedVerification)).toBe('failed_verification');
  });

  it('never hides a concluded verification outcome behind a stale cancellation request either', () => {
    expect(deriveRunStatus('cancelled', completedUnverified)).toBe('completed_unverified');
    expect(deriveRunStatus('cancelled', failedVerification)).toBe('failed_verification');
  });

  it('reports verifying once the runtime finished and gate evidence is being produced, distinct from plain running', () => {
    const justCompleted: AttemptState = {
      state: 'running',
      runtime: 'codex',
      startedAt: record.startedAt,
      events: [{ kind: 'completion', sequence: 0, at: '2026-09-01T00:01:00.000Z', outcome: 'success' }],
    };
    const midCheck: AttemptState = {
      state: 'running',
      runtime: 'codex',
      startedAt: record.startedAt,
      events: [{
        kind: 'verification-check', sequence: 1, at: '2026-09-01T00:01:01.000Z', gate: 'tests', command: 'npm test',
        required: true, passed: false, exitCode: 1, evidence: 'boom',
      }],
    };
    expect(deriveRunStatus('running', justCompleted)).toBe('verifying');
    expect(deriveRunStatus('running', midCheck)).toBe('verifying');
  });

  it('reports running (not verifying) once a repair round starts doing runtime work again', () => {
    const repairing: AttemptState = {
      state: 'running',
      runtime: 'codex',
      startedAt: record.startedAt,
      events: [{ kind: 'lifecycle', sequence: 2, at: '2026-09-01T00:01:02.000Z', phase: 'attempt-started' }],
    };
    expect(deriveRunStatus('running', repairing)).toBe('running');
  });

  it('reports waiting_approval or waiting_input while a request is open, and plain running once it is not', () => {
    const approval = { id: 'attention-1', kind: 'approval' as const, reason: 'Approve?', requestedAt: record.startedAt };
    const input = { id: 'attention-1', kind: 'input' as const, reason: 'What next?', requestedAt: record.startedAt };
    expect(deriveRunStatus('running', running, approval)).toBe('waiting_approval');
    expect(deriveRunStatus('running', running, input)).toBe('waiting_input');
    expect(deriveRunStatus('running', running)).toBe('running');
  });

  it('never reports waiting_* once the Attempt has a terminal outcome, even with a pending-looking request passed in', () => {
    const approval = { id: 'attention-1', kind: 'approval' as const, reason: 'Approve?', requestedAt: record.startedAt };
    expect(deriveRunStatus('running', completed, approval)).toBe('completed');
    expect(deriveRunStatus('running', failed, approval)).toBe('failed');
  });
});

describe('deriveOpenAttentionRequest', () => {
  it('reports nothing for an idle or non-running Attempt, regardless of any stray events', () => {
    expect(deriveOpenAttentionRequest({ state: 'idle' })).toBeUndefined();
  });

  it('reports nothing while running with no attention-requested event', () => {
    expect(deriveOpenAttentionRequest({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events: [],
    })).toBeUndefined();
  });

  it('reports an open approval request the instant it is requested', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started' },
      {
        kind: 'attention-requested', sequence: 1, at: '2026-09-01T00:00:02.000Z',
        attentionId: 'attention-1', attentionKind: 'approval', reason: 'Approve: rm -rf node_modules',
      },
    ];
    expect(deriveOpenAttentionRequest({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events,
    })).toEqual({
      id: 'attention-1', kind: 'approval', reason: 'Approve: rm -rf node_modules', requestedAt: '2026-09-01T00:00:02.000Z',
    });
  });

  it('reports nothing once a matching attention-resolved event has landed', () => {
    const events: AttemptEvent[] = [
      {
        kind: 'attention-requested', sequence: 0, at: '2026-09-01T00:00:01.000Z',
        attentionId: 'attention-1', attentionKind: 'approval', reason: 'Approve?',
      },
      {
        kind: 'attention-resolved', sequence: 1, at: '2026-09-01T00:00:02.000Z', attentionId: 'attention-1', decision: 'approved',
      },
    ];
    expect(deriveOpenAttentionRequest({
      state: 'running', runtime: 'codex', startedAt: record.startedAt, events,
    })).toBeUndefined();
  });

  it('never reopens a resolved request even once the Attempt reaches a terminal outcome', () => {
    const events: AttemptEvent[] = [
      {
        kind: 'attention-requested', sequence: 0, at: '2026-09-01T00:00:01.000Z',
        attentionId: 'attention-1', attentionKind: 'approval', reason: 'Approve?',
      },
      {
        kind: 'attention-resolved', sequence: 1, at: '2026-09-01T00:00:02.000Z', attentionId: 'attention-1', decision: 'approved',
      },
      { kind: 'completion', sequence: 2, at: '2026-09-01T00:00:03.000Z', outcome: 'success' },
    ];
    expect(deriveOpenAttentionRequest({
      state: 'completed', runtime: 'codex', startedAt: record.startedAt, events, completedAt: '2026-09-01T00:00:03.000Z',
    })).toBeUndefined();
  });
});
