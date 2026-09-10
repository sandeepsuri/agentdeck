// The shared runtime Attempt contract (ticket 05, extended to Claude by
// ticket 14): every managed runtime executes one Attempt inside its frozen
// capability envelope and reports the same ordered AttemptEvent stream.
// Provider conversation identity and every other runtime-specific field
// stay inside the adapter's own closure — never in a yielded event.
import type { AgentType } from '../../types.js';
import type { AttemptEvent, AttentionDecisionInput, EnvelopeProfile } from '../types.js';

/** Everything an adapter needs to run one Attempt — nothing more; never the raw WorkRun, Store, or Secret values. */
export interface AttemptLaunchContext {
  readonly runId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  /** The prepared, dedicated worktree the Attempt runs inside (ticket 03). */
  readonly worktreePath: string;
  /** The frozen capability envelope Profile the adapter must enforce when it launches its runtime process (ticket 04). */
  readonly profile: EnvelopeProfile;
  /**
   * Ticket 07: after an adapter yields an 'attention-requested' event for
   * `attentionId`, it awaits this to learn the operator's decision — the one
   * policy path every transport's resolve command ultimately reaches
   * (DurableWorkEngine.resolveAttention). Optional so existing adapter-
   * contract test contexts (which never trigger an attention request) don't
   * need it; an adapter must still never hang when it's absent — see
   * runtimes/codex.ts's fallback.
   */
  readonly awaitAttentionDecision?: (attentionId: string) => Promise<AttentionDecisionInput>;
  /**
   * Ticket 09 AC5/AC1: resolves once the engine has decided to stop this
   * round right now — a cancellation, or a wall-clock budget firing. An
   * adapter that owns a real process (runtimes/codex.ts) is expected to
   * listen for this itself and kill that process directly the moment it
   * resolves, rather than relying on its `run()` generator being asked to
   * `.return()`: once a `.next()` call on it is already outstanding (always
   * true for an actively-consumed generator), `.return()` only queues
   * behind that call and never takes effect if it never settles — exactly
   * the case a genuinely hung runtime is. Optional for the same reason
   * `awaitAttentionDecision` is: existing adapter-contract test contexts
   * never set it, and an adapter must still behave correctly without it —
   * it simply cannot be stopped mid-round from outside in that case.
   */
  readonly abortRequested?: Promise<void>;
}

export interface RuntimeAttemptAdapter {
  readonly runtime: AgentType;
  /** Yields the ordered AttemptEvent stream for one Attempt, ending in exactly one completion or failure event. */
  run(context: AttemptLaunchContext): AsyncIterable<AttemptEvent>;
}
