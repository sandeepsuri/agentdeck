// Ticket 71 (B09, docs/specs/run-feedback-review.md): a pure, derived
// (never stored) review state — no Store, no engine, so this is exercised
// as plain unit tests over fixture WorkRun/RunFeedbackEntry values.
import { describe, expect, it } from 'vitest';
import type { RunFeedbackEntry } from '../types.js';
import type { WorkRun } from './types.js';
import { deriveRunReviewState } from './run-review.js';

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
    preparation: { state: 'pending' },
    envelope: { state: 'pending' },
    verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

const feedback = (id: string, overrides: Partial<RunFeedbackEntry> = {}): RunFeedbackEntry => ({
  id, taskId: 'task-1', runId: 'run-1', sequence: Number(id), postedAt: `2026-09-01T00:0${id}:00.000Z`,
  displayName: 'Alice', text: 'a comment', ...overrides,
});

describe('deriveRunReviewState', () => {
  it('is not_applicable for a still-running Run with no result yet', () => {
    expect(deriveRunReviewState(baseRun({ status: 'running' }), [])).toEqual({ state: 'not_applicable' });
  });

  it('is not_applicable for a failed Run with no decision yet — still not a review target', () => {
    const run = baseRun({
      status: 'failed',
      attempt: {
        state: 'failed', runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z', failedAt: '2026-09-01T00:01:00.000Z',
        reason: 'crashed', events: [{ kind: 'failure', sequence: 0, at: '2026-09-01T00:01:00.000Z', reason: 'crashed' }],
      },
    });
    expect(deriveRunReviewState(run, [])).toEqual({ state: 'not_applicable' });
  });

  it('is ready_to_review for a completed_unverified Run with no decision yet', () => {
    const run = baseRun({
      status: 'completed_unverified',
      attempt: {
        state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
        events: [
          { kind: 'completion', sequence: 0, at: '2026-09-01T00:00:30.000Z', outcome: 'success' },
          { kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'unverified', repairAttempts: 0 },
        ],
      },
    });
    expect(deriveRunReviewState(run, [feedback('1')])).toEqual({ state: 'ready_to_review' });
  });

  it('is ready_to_review for a verified completed Run with no decision yet', () => {
    const run = baseRun({
      status: 'completed',
      attempt: {
        state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
        events: [
          { kind: 'completion', sequence: 0, at: '2026-09-01T00:00:30.000Z', outcome: 'success' },
          { kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'verified', repairAttempts: 0 },
        ],
      },
    });
    expect(deriveRunReviewState(run, [])).toEqual({ state: 'ready_to_review' });
  });

  it('reports the latest review decision, by whom and when, once one exists', () => {
    const run = baseRun({
      status: 'completed_unverified',
      attempt: {
        state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
        events: [
          { kind: 'completion', sequence: 0, at: '2026-09-01T00:00:30.000Z', outcome: 'success' },
          { kind: 'verification-outcome', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'unverified', repairAttempts: 0 },
        ],
      },
    });
    const entries = [
      feedback('1', { text: 'a plain comment first' }),
      feedback('2', { displayName: 'Bob', text: 'Please add a test', reviewDecision: 'changes_requested' }),
    ];
    expect(deriveRunReviewState(run, entries)).toEqual({
      state: 'changes_requested', reviewedBy: 'Bob', reviewedAt: entries[1]!.postedAt,
    });
  });

  it('takes the latest decision when more than one has been posted, never an earlier one', () => {
    const run = baseRun({ status: 'completed_unverified', attempt: { state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', events: [] } });
    const entries = [
      feedback('1', { displayName: 'Bob', reviewDecision: 'changes_requested' }),
      feedback('2', { text: 'fixed it' }),
      feedback('3', { displayName: 'Carol', reviewDecision: 'reviewed' }),
    ];
    expect(deriveRunReviewState(run, entries)).toEqual({ state: 'reviewed', reviewedBy: 'Carol', reviewedAt: entries[2]!.postedAt });
  });

  it('a review decision survives even once the Run\'s own status later looks unrelated (e.g. a later retry landed on a different attempt)', () => {
    const run = baseRun({ status: 'failed' });
    const entries = [feedback('1', { displayName: 'Alice', reviewDecision: 'reviewed' })];
    expect(deriveRunReviewState(run, entries)).toEqual({ state: 'reviewed', reviewedBy: 'Alice', reviewedAt: entries[0]!.postedAt });
  });
});
