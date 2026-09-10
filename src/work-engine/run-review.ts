// Ticket 71 (B09, docs/specs/run-feedback-review.md): a review decision is
// never a new RunStatus transition, never the dormant 'reviewing' value —
// execution lifecycle and human sign-off are independently-varying facts.
// "Ready to review" is derived, never stored, and a review decision is
// itself just a specially-tagged RunFeedbackEntry (server/run-feedback.ts,
// ticket 67/B07) — this module never touches RunActivity, the 'approval'
// attention kind, or RunStatus.
import type { ReviewDecision, RunFeedbackEntry } from '../types.js';
import { deriveRunResult } from './run-result.js';
import type { WorkRun } from './types.js';

export interface RunReviewState {
  readonly state: ReviewDecision | 'ready_to_review' | 'not_applicable';
  /** Display name only, mirrors CollaboratorRunSummary.requestedBy — present only once a decision has been recorded. */
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

/**
 * The current review state for a Run's Task: the latest feedback entry
 * carrying a `reviewDecision`, if any, wins outright — regardless of what
 * the Run's own status has done since (a reviewer may legitimately mark a
 * failed Run reviewed after commenting on why it failed). Only once no
 * decision has ever been recorded does this fall back to "ready to
 * review" (a settled, resulted Run — completed or completed_unverified)
 * or "not applicable" (anything else: still running, or a failure with
 * nothing yet said about it).
 */
export function deriveRunReviewState(run: WorkRun, feedback: readonly RunFeedbackEntry[]): RunReviewState {
  const latestDecision = [...feedback].reverse().find((entry) => entry.reviewDecision !== undefined);
  if (latestDecision?.reviewDecision) {
    return { state: latestDecision.reviewDecision, reviewedBy: latestDecision.displayName, reviewedAt: latestDecision.postedAt };
  }
  const result = deriveRunResult(run);
  if (result && (result.outcome === 'completed' || result.outcome === 'completed_unverified')) {
    return { state: 'ready_to_review' };
  }
  return { state: 'not_applicable' };
}
