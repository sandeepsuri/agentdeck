// Durable Task/Run feedback (docs/specs/run-feedback-review.md, B07): plain,
// free-text commentary keyed by Task, deliberately parallel to
// session-conversation.ts but independent of it — a Run has no reliably
// attachable Session (see B13's own finding), and feedback must stay
// readable for a completed/failed/cancelled Run with no live process at
// all. Never routed to a runtime, and never a client-only "resumed" signal
// — see the design doc's own "Scope and constraints carried over from
// #37". Ticket 71 (B09): a review decision (reviewDecision below) IS built
// on this same module, deliberately — see run-review.ts's own header for
// why it is never RunActivity, the 'approval' attention kind, or a new
// RunStatus transition.
import { randomUUID } from 'node:crypto';
import type { ReviewDecision, RunFeedbackEntry } from '../types.js';

export type { RunFeedbackEntry };

/** The minimal storage seam this module needs — satisfied by Store (store/index.ts), and by a fake in this module's own tests. */
export interface RunFeedbackStore {
  appendRunFeedback(input: {
    id: string; taskId: string; runId: string; postedAt: string;
    principalId?: string; displayName: string; text: string;
    reviewDecision?: ReviewDecision;
  }): RunFeedbackEntry;
  listRunFeedback(taskId: string): RunFeedbackEntry[];
}

/** Same bound as routes.ts's own MAX_MESSAGE_LENGTH for session chat — both are free-text human posts, so neither gets a stricter or looser limit than the other. */
export const MAX_FEEDBACK_TEXT_LENGTH = 64 * 1024;

export type PostRunFeedbackResult =
  | { readonly ok: true; readonly entry: RunFeedbackEntry }
  | { readonly ok: false; readonly error: string };

/**
 * Validates and durably records one feedback post. The only place this
 * validation happens — the route defers to it entirely, so any future
 * second caller (a CLI, a future structured-reply path) gets the same rule
 * for free rather than a re-implemented copy.
 *
 * `principalId`/`displayName` are resolved by the caller (the route, from
 * the authenticated connection — see server/index.ts's resolveAuthor dep)
 * and trusted as given; this function never reads a caller-supplied name
 * out of `text` or any other request field.
 *
 * Ticket 71 (B09): `reviewDecision`, when given, must be exactly
 * `'changes_requested'` or `'reviewed'` — validated here, the one place
 * this rule exists, same as every other validation in this function. A
 * review decision still needs its own non-empty `text`, unchanged from an
 * ordinary comment's own rule.
 */
export function postRunFeedback(
  store: RunFeedbackStore,
  input: {
    taskId: string; runId: string; principalId?: string; displayName: string; text: unknown;
    reviewDecision?: unknown;
  },
): PostRunFeedbackResult {
  if (input.reviewDecision !== undefined && input.reviewDecision !== 'changes_requested' && input.reviewDecision !== 'reviewed') {
    return { ok: false, error: 'reviewDecision must be "changes_requested" or "reviewed"' };
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return { ok: false, error: 'text is required' };
  if (text.length > MAX_FEEDBACK_TEXT_LENGTH) return { ok: false, error: 'text is too long' };
  const entry = store.appendRunFeedback({
    id: randomUUID(),
    taskId: input.taskId,
    runId: input.runId,
    postedAt: new Date().toISOString(),
    ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
    displayName: input.displayName,
    text,
    ...(input.reviewDecision !== undefined ? { reviewDecision: input.reviewDecision } : {}),
  });
  return { ok: true, entry };
}

/** Every feedback entry for one Run's Task, oldest first — see migrations/020_run_feedback.sql's own header for why this is keyed by Task rather than Run. */
export function listRunFeedback(store: RunFeedbackStore, taskId: string): RunFeedbackEntry[] {
  return store.listRunFeedback(taskId);
}
