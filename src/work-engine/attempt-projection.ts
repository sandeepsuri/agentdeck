// Ticket 06: the pure reducer at the center of durable recovery. An
// Attempt's AttemptState (ticket 05) is never stored as its own mutable
// snapshot — it is folded, on every read, from the Attempt's durable event
// log (work-engine/durable-events.ts, store/index.ts). Restart therefore has
// no special "rebuild" step: the projection below is the *only* way this
// state is ever produced, so a fresh process reconstructs exactly what a
// long-lived one would show.
import type { AgentType } from '../types.js';
import type { AttemptEvent, AttemptState, WorkRun } from './types.js';

export interface AttemptRecordMeta {
  readonly runtime: AgentType;
  readonly startedAt: string;
}

/**
 * `record` is undefined when no Attempt has ever been started for the Run —
 * projects to 'idle'. Otherwise the ordered `events` (already durable,
 * already deduplicated) decide the rest: no terminal event yet means
 * 'running'; a trailing completion or failure event freezes the matching
 * terminal state, exactly as the runtime adapter contract guarantees at
 * most one such event, and only ever last.
 */
export function projectAttemptState(
  record: AttemptRecordMeta | undefined,
  events: readonly AttemptEvent[],
): AttemptState {
  if (!record) return { state: 'idle' };
  const { runtime, startedAt } = record;
  const last = events.at(-1);
  if (last?.kind === 'completion') {
    return {
      state: 'completed', runtime, startedAt, events, completedAt: last.at,
    };
  }
  if (last?.kind === 'failure') {
    return {
      state: 'failed', runtime, startedAt, events, failedAt: last.at, reason: last.reason,
    };
  }
  return { state: 'running', runtime, startedAt, events };
}

/**
 * The other half of ticket 06 AC4: once an Attempt exists, its own terminal
 * state is a Run's `status` for exactly the running/completed/failed values
 * — never written separately, so the two can never be found disagreeing
 * after a crash (see Store.attachAttempt, the only caller).
 *
 * A raw `status` of 'cancelled' still takes priority over a merely-'running'
 * Attempt: cancel() writes it precisely so that intent stays visible while
 * the Attempt has not yet reached a real terminal state (ticket 06 doesn't
 * stop the underlying process — that's ticket 09's "safe controls"). But a
 * definitive completion or failure event always wins over it: the real
 * outcome, once known, is never hidden behind a stale cancellation request
 * that lost the race.
 */
export function deriveRunStatus(rawStatus: WorkRun['status'], attempt: AttemptState): WorkRun['status'] {
  if (attempt.state === 'completed' || attempt.state === 'failed') return attempt.state;
  if (rawStatus === 'cancelled') return 'cancelled';
  if (attempt.state === 'running') return 'running';
  return rawStatus;
}
