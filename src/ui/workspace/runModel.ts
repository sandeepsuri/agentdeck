import type { RunStatus, WorkRun } from '../../work-engine/types.js';

/** Every durable Run state, kept explicit so filters cannot silently merge failures or unverified completion. */
export const RUN_STATUS_OPTIONS: readonly RunStatus[] = [
  'queued', 'preparing', 'running', 'waiting_approval', 'waiting_input', 'waiting_dependency',
  'verifying', 'reviewing', 'pause_requested', 'paused', 'completed', 'completed_unverified',
  'failed_verification', 'failed_budget', 'failed', 'cancelled',
];

export function formatRunLabel(value: string): string {
  const words = value.replaceAll('-', ' ').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Mirrors work-engine/engine.ts's TERMINAL_STATUSES — a Run in one of these will never change status again, so it's the only state deletion is offered from. */
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'completed_unverified', 'failed_verification', 'failed_budget', 'failed', 'cancelled',
]);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Ticket 68 (B12): mirrors work-engine/engine.ts's RETRYABLE_STATUSES — the statuses "Start a new attempt" is ever offered for. 'completed' is deliberately excluded: nothing to recover, publish() already covers that case. */
const RETRY_ATTEMPT_ELIGIBLE_STATUSES = new Set([
  'failed', 'failed_budget', 'cancelled', 'failed_verification', 'completed_unverified',
]);

export function isRetryAttemptEligibleStatus(status: string): boolean {
  return RETRY_ATTEMPT_ELIGIBLE_STATUSES.has(status);
}

/**
 * Runs needing a decision first, then the rest still in flight, then
 * finished work — newest first within each band. Shared by every view that
 * browses Runs across Repositories (Overview's per-Repository page, ticket
 * 47; the Tasks browsing list, ticket 48) so they band and order Runs the
 * same way rather than drifting into two similar-but-different sorts.
 */
export function orderRuns(runs: readonly WorkRun[]): WorkRun[] {
  return [...runs].sort((a, b) => {
    const bandOf = (run: WorkRun) => run.pendingAttention ? 0 : isTerminalRunStatus(run.status) ? 2 : 1;
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    return b.submittedAt.localeCompare(a.submittedAt);
  });
}
