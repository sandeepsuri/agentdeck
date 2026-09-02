// Ticket 06: the pure reducer at the center of durable recovery. An
// Attempt's AttemptState (ticket 05) is never stored as its own mutable
// snapshot — it is folded, on every read, from the Attempt's durable event
// log (work-engine/durable-events.ts, store/index.ts). Restart therefore has
// no special "rebuild" step: the projection below is the *only* way this
// state is ever produced, so a fresh process reconstructs exactly what a
// long-lived one would show.
import type { AgentType } from '../types.js';
import type {
  AttemptEvent, AttemptState, RunAttentionRequest, VerificationOutcome, WorkRun,
} from './types.js';

export interface AttemptRecordMeta {
  readonly runtime: AgentType;
  readonly startedAt: string;
}

/**
 * `record` is undefined when no Attempt has ever been started for the Run —
 * projects to 'idle'. Otherwise the ordered `events` (already durable,
 * already deduplicated) decide the rest:
 *
 * - a trailing 'failure' or 'budget-exceeded' event freezes 'failed' — a
 *   runtime failure or a hard resource limit (ticket 09) never goes through
 *   verification (ticket 08 AC6); RunStatus (deriveRunStatus below) is where
 *   'failed' vs. 'failed_budget' actually surfaces;
 * - a trailing 'verification-outcome' event (ticket 08) freezes 'completed'
 *   — the runtime itself always finished normally for one to exist at all,
 *   whichever gate outcome it records; RunStatus (deriveRunStatus below) is
 *   where that outcome (verified/unverified/failed_verification) actually
 *   surfaces;
 * - anything else — including a trailing 'completion' event with no
 *   verification-outcome yet, or a 'verification-check' evidence event mid
 *   repair cycle — means the Attempt has not truly settled: verification or
 *   a repair round is still in progress (or, after a restart with no live
 *   process left to finish it, permanently unresolved — see recovery.ts's
 *   describeUnverifiedCompletion). Reporting 'running' here, not 'completed',
 *   is what lets DurableWorkEngine.recover() (ticket 06) still treat it as
 *   abandoned mid-flight instead of silently accepting an unverified outcome
 *   (ticket 08 AC8).
 */
export function projectAttemptState(
  record: AttemptRecordMeta | undefined,
  events: readonly AttemptEvent[],
): AttemptState {
  if (!record) return { state: 'idle' };
  const { runtime, startedAt } = record;
  const last = events.at(-1);
  if (last?.kind === 'failure') {
    return {
      state: 'failed', runtime, startedAt, events, failedAt: last.at, reason: last.reason,
    };
  }
  if (last?.kind === 'budget-exceeded') {
    return {
      state: 'failed', runtime, startedAt, events, failedAt: last.at, reason: describeBudgetExceeded(last),
    };
  }
  if (last?.kind === 'verification-outcome') {
    const completedAt = [...events].reverse().find((event) => event.kind === 'completion')?.at ?? last.at;
    return {
      state: 'completed', runtime, startedAt, events, completedAt,
    };
  }
  return { state: 'running', runtime, startedAt, events };
}

/** A precise, human-readable reason for a hard-limit failure — the same "explicit" bar AC3 asks of the durable event itself. */
function describeBudgetExceeded(event: { limit: string; configured: number; observed: number }): string {
  return `Hard limit exceeded: ${event.limit} (configured ${event.configured}, observed ${event.observed}).`;
}

/**
 * Ticket 09 AC4: whether a pause is merely requested, has taken effect, or
 * neither — folded from the durable event log so a restart (recovery.ts)
 * and a live read (deriveRunStatus below) can never disagree. 'resumed'
 * cancels a prior request/pause back to 'none', exactly like
 * 'attention-resolved' cancels a pending attention request.
 */
export type PauseState = 'none' | 'requested' | 'paused';

export function derivePauseState(events: readonly AttemptEvent[]): PauseState {
  let state: PauseState = 'none';
  for (const event of events) {
    if (event.kind === 'pause-requested') state = 'requested';
    else if (event.kind === 'paused') state = 'paused';
    else if (event.kind === 'resumed') state = 'none';
  }
  return state;
}

/**
 * Ticket 07: which attention request (if any) is still open, folded from
 * the same durable event log projectAttemptState already reads — never its
 * own stored record, so a restart can never disagree with what actually
 * happened. Only ever computed for a still-'running' Attempt: once the
 * Attempt has a terminal event, any trailing 'attention-requested' with no
 * matching 'attention-resolved' is moot (AC4 — a completed/failed Attempt
 * never reopens a request nobody got to answer) rather than surfaced as
 * still pending.
 */
export function deriveOpenAttentionRequest(attempt: AttemptState): RunAttentionRequest | undefined {
  if (attempt.state !== 'running') return undefined;
  const open = new Map<string, RunAttentionRequest>();
  for (const event of attempt.events) {
    if (event.kind === 'attention-requested') {
      open.set(event.attentionId, {
        id: event.attentionId, kind: event.attentionKind, reason: event.reason, requestedAt: event.at,
      });
    } else if (event.kind === 'attention-resolved') {
      open.delete(event.attentionId);
    }
  }
  // The adapter contract only ever awaits one outstanding request at a time
  // (see runtimes/codex.ts) — insertion order (oldest first) is a
  // deterministic, well-defined choice even if that were ever relaxed.
  return open.values().next().value;
}

const VERIFICATION_OUTCOME_STATUS: Readonly<Record<VerificationOutcome, WorkRun['status']>> = {
  verified: 'completed',
  unverified: 'completed_unverified',
  failed_verification: 'failed_verification',
};

/**
 * Ticket 08: while an Attempt's own AttemptState reads 'running', its
 * trailing event tells the finer-grained story RunStatus surfaces —
 * 'verifying' once the runtime finished and gates are being run or a repair
 * round decided on, back to plain 'running' the instant a repair round's own
 * 'attempt-started' lifecycle event lands (it is doing runtime work again,
 * not waiting on verification).
 */
function isVerifying(events: readonly AttemptEvent[]): boolean {
  const last = events.at(-1);
  return last?.kind === 'completion' || last?.kind === 'verification-check';
}

/**
 * The other half of ticket 06 AC4 (extended by ticket 08): once an Attempt
 * exists, its own terminal state is a Run's `status` — never written
 * separately, so the two can never be found disagreeing after a crash (see
 * Store.attachAttempt, the only caller).
 *
 * A raw `status` of 'cancelled' still takes priority over a merely-'running'
 * Attempt: cancel() writes it precisely so that intent stays visible while
 * the Attempt has not yet reached a real terminal state (ticket 06 doesn't
 * stop the underlying process — that's ticket 09's "safe controls"; ticket
 * 08's verification/repair loop does check for it between rounds, so a
 * cancellation made during verification actually stops further repair work,
 * not just this cosmetic read). But a definitive failure or verification
 * outcome always wins over it: the real outcome, once known, is never hidden
 * behind a stale cancellation request that lost the race.
 *
 * Ticket 07: a still-open attention request reports 'waiting_approval' or
 * 'waiting_input' instead of the bare 'running' those statuses already
 * declared (types.ts) — still subordinate to a real terminal outcome or an
 * already-recorded cancellation exactly like 'running' was.
 */
export function deriveRunStatus(
  rawStatus: WorkRun['status'],
  attempt: AttemptState,
  pendingAttention?: RunAttentionRequest,
): WorkRun['status'] {
  if (attempt.state === 'failed') {
    // projectAttemptState only ever freezes 'failed' from a trailing
    // 'failure' or 'budget-exceeded' event — see its own doc comment.
    return attempt.events.at(-1)?.kind === 'budget-exceeded' ? 'failed_budget' : 'failed';
  }
  if (attempt.state === 'completed') {
    const outcome = attempt.events.at(-1);
    // projectAttemptState only ever freezes 'completed' from a trailing
    // verification-outcome event — see its own doc comment.
    if (outcome?.kind !== 'verification-outcome') throw new Error('expected a trailing verification-outcome event');
    return VERIFICATION_OUTCOME_STATUS[outcome.outcome];
  }
  if (rawStatus === 'cancelled') return 'cancelled';
  if (attempt.state === 'running') {
    if (pendingAttention?.kind === 'approval') return 'waiting_approval';
    if (pendingAttention?.kind === 'input') return 'waiting_input';
    // Ticket 09 AC4: a pause takes priority over the plain 'verifying'/
    // 'running' read below — it is the more actionable fact once known.
    const pause = derivePauseState(attempt.events);
    if (pause === 'paused') return 'paused';
    if (pause === 'requested') return 'pause_requested';
    if (isVerifying(attempt.events)) return 'verifying';
    return 'running';
  }
  return rawStatus;
}
