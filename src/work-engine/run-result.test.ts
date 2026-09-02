import { describe, expect, it } from 'vitest';
import { deriveRunResult } from './run-result.js';
import type { AttemptEvent, WorkRun, WorkSpec } from './types.js';

const spec: WorkSpec = {
  objective: 'Add the missing test',
  acceptanceCriteria: ['The test exists', 'The test passes'],
  repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
  requestedBaseReference: 'main',
  runtimePreference: ['codex'],
  budget: { maxWallClockMs: 60_000, maxRepairAttempts: 1 },
  verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit',
};

function baseRun(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: 'queued',
    spec,
    submittedAt: '2026-09-01T00:00:00.000Z',
    principal: { id: 'local:sandeep', displayName: 'sandeep' },
    preparation: { state: 'pending' },
    envelope: { state: 'pending' },
    verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

function withEvents(state: 'completed' | 'failed', events: readonly AttemptEvent[]): WorkRun['attempt'] {
  if (state === 'failed') {
    const last = events.at(-1);
    if (last?.kind !== 'failure') throw new Error('trailing event must be a failure event');
    return {
      state: 'failed', runtime: 'codex', startedAt: '2026-09-01T00:01:00.000Z', events, failedAt: last.at, reason: last.reason,
    };
  }
  return {
    state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:01:00.000Z', events, completedAt: '2026-09-01T00:02:00.000Z',
  };
}

describe('deriveRunResult', () => {
  it('is undefined while the Attempt has not reached a terminal state (idle or running)', () => {
    expect(deriveRunResult(baseRun({ attempt: { state: 'idle' } }))).toBeUndefined();
    expect(deriveRunResult(baseRun({
      attempt: { state: 'running', runtime: 'codex', startedAt: '2026-09-01T00:01:00.000Z', events: [] },
    }))).toBeUndefined();
  });

  it('reports the submitted intent, outcome, changed files, and commit for a verified, committed Run (AC4)', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:01:00.000Z', phase: 'attempt-started' },
      { kind: 'completion', sequence: 1, at: '2026-09-01T00:01:30.000Z', outcome: 'success' },
      {
        kind: 'commit-created', sequence: 2, at: '2026-09-01T00:01:31.000Z', sha: 'abc123', branch: 'agentdeck/run/run-1',
        signed: false, changedFiles: ['src/index.ts', 'src/index.test.ts'],
      },
      {
        kind: 'verification-outcome', sequence: 3, at: '2026-09-01T00:01:32.000Z', outcome: 'verified', repairAttempts: 0,
      },
    ];
    const run = baseRun({ status: 'completed', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result).toEqual({
      objective: 'Add the missing test',
      acceptanceCriteria: ['The test exists', 'The test passes'],
      outcome: 'completed',
      changedFiles: ['src/index.ts', 'src/index.test.ts'],
      commit: { sha: 'abc123', branch: 'agentdeck/run/run-1', signed: false },
      verificationEvidence: [],
      approvals: [],
      budget: spec.budget,
    });
  });

  it('includes durable verification-check evidence and resolved approvals', () => {
    const events: AttemptEvent[] = [
      {
        kind: 'attention-requested', sequence: 0, at: '2026-09-01T00:01:00.000Z', attentionId: 'a-1',
        attentionKind: 'approval', reason: 'Approve: rm -rf node_modules',
      },
      {
        kind: 'attention-resolved', sequence: 1, at: '2026-09-01T00:01:05.000Z', attentionId: 'a-1', decision: 'approved',
      },
      { kind: 'completion', sequence: 2, at: '2026-09-01T00:01:30.000Z', outcome: 'success' },
      {
        kind: 'verification-check', sequence: 3, at: '2026-09-01T00:01:31.000Z', gate: 'tests', command: 'npm test',
        required: true, passed: true, exitCode: 0, evidence: 'ok',
      },
      {
        kind: 'verification-outcome', sequence: 4, at: '2026-09-01T00:01:32.000Z', outcome: 'verified', repairAttempts: 0,
      },
    ];
    const run = baseRun({ status: 'completed', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.approvals).toEqual([{
      attentionId: 'a-1', kind: 'approval', reason: 'Approve: rm -rf node_modules', decision: 'approved', resolvedAt: '2026-09-01T00:01:05.000Z',
    }]);
    expect(result?.verificationEvidence).toEqual([events[3]]);
  });

  it('reports the last usage snapshot, when any usage event exists', () => {
    const events: AttemptEvent[] = [
      { kind: 'usage', sequence: 0, at: '2026-09-01T00:01:10.000Z', inputTokens: 100, outputTokens: 50 },
      { kind: 'usage', sequence: 1, at: '2026-09-01T00:01:20.000Z', inputTokens: 200, outputTokens: 'unknown' },
      { kind: 'completion', sequence: 2, at: '2026-09-01T00:01:30.000Z', outcome: 'no-changes' },
      {
        kind: 'verification-outcome', sequence: 3, at: '2026-09-01T00:01:32.000Z', outcome: 'unverified', repairAttempts: 0,
      },
    ];
    const run = baseRun({ status: 'completed_unverified', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.usage).toEqual({ inputTokens: 200, outputTokens: 'unknown' });
  });

  it('reports no commit and empty changed files for a Run with no changes to deliver', () => {
    const events: AttemptEvent[] = [
      { kind: 'completion', sequence: 0, at: '2026-09-01T00:01:30.000Z', outcome: 'no-changes' },
      {
        kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:32.000Z', outcome: 'verified', repairAttempts: 0,
      },
    ];
    const run = baseRun({ status: 'completed', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.changedFiles).toEqual([]);
    expect(result?.commit).toBeUndefined();
  });

  it('reports a failed delivery commit through recoveryNotes without hiding the underlying verified status (AC4)', () => {
    const events: AttemptEvent[] = [
      { kind: 'completion', sequence: 0, at: '2026-09-01T00:01:30.000Z', outcome: 'success' },
      { kind: 'commit-failed', sequence: 1, at: '2026-09-01T00:01:31.000Z', reason: 'commit hook rejected the change' },
      {
        kind: 'verification-outcome', sequence: 2, at: '2026-09-01T00:01:32.000Z', outcome: 'verified', repairAttempts: 0,
      },
    ];
    const run = baseRun({ status: 'completed', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.outcome).toBe('completed');
    expect(result?.commit).toBeUndefined();
    expect(result?.recoveryNotes).toBe('commit hook rejected the change');
  });

  it('produces an honest non-success result for a failed Run, with the precise failure reason as recoveryNotes (AC7)', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:01:00.000Z', phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: '2026-09-01T00:01:05.000Z', reason: 'The sandboxed command exited non-zero.' },
    ];
    const run = baseRun({ status: 'failed', attempt: withEvents('failed', events) });

    const result = deriveRunResult(run);

    expect(result).toMatchObject({ outcome: 'failed', changedFiles: [], recoveryNotes: 'The sandboxed command exited non-zero.' });
    expect(result?.commit).toBeUndefined();
  });

  it('produces an honest non-success result for a Run recovered as unrecoverable after a restart (AC7)', () => {
    const events: AttemptEvent[] = [
      { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:01:00.000Z', phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: '2026-09-01T00:01:05.000Z', reason: 'AgentDeck restarted before this Attempt finished.' },
    ];
    const run = baseRun({ status: 'failed', attempt: withEvents('failed', events) });

    const result = deriveRunResult(run);

    expect(result?.recoveryNotes).toBe('AgentDeck restarted before this Attempt finished.');
  });

  it('always carries the frozen budget through, unchanged, for a failed-verification outcome too (AC7)', () => {
    const events: AttemptEvent[] = [
      { kind: 'completion', sequence: 0, at: '2026-09-01T00:01:30.000Z', outcome: 'success' },
      {
        kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:32.000Z', outcome: 'failed_verification', repairAttempts: 1,
      },
    ];
    const run = baseRun({ status: 'failed_verification', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.outcome).toBe('failed_verification');
    expect(result?.budget).toEqual(spec.budget);
    expect(result?.commit).toBeUndefined();
  });

  it('synthesizes a recovery note for exhausted repairs, not just a bare failed_verification outcome (AC7)', () => {
    const events: AttemptEvent[] = [
      { kind: 'completion', sequence: 0, at: '2026-09-01T00:01:30.000Z', outcome: 'success' },
      {
        kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:32.000Z', outcome: 'failed_verification', repairAttempts: 2,
      },
    ];
    const run = baseRun({ status: 'failed_verification', attempt: withEvents('completed', events) });

    const result = deriveRunResult(run);

    expect(result?.recoveryNotes).toBe('Verification did not pass after 2 repair attempt(s).');
  });
});
