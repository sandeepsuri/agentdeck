// The shared runtime Attempt contract (ticket 05, extended to Claude by
// ticket 14): every managed runtime executes one Attempt inside its frozen
// capability envelope and reports the same ordered AttemptEvent stream.
// Provider conversation identity and every other runtime-specific field
// stay inside the adapter's own closure — never in a yielded event.
import type { AgentType } from '../../types.js';
import type { AttemptEvent, EnvelopeProfile } from '../types.js';

/** Everything an adapter needs to run one Attempt — nothing more; never the raw WorkRun, Store, or Secret values. */
export interface AttemptLaunchContext {
  readonly runId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  /** The prepared, dedicated worktree the Attempt runs inside (ticket 03). */
  readonly worktreePath: string;
  /** The frozen capability envelope Profile the adapter must enforce when it launches its runtime process (ticket 04). */
  readonly profile: EnvelopeProfile;
}

export interface RuntimeAttemptAdapter {
  readonly runtime: AgentType;
  /** Yields the ordered AttemptEvent stream for one Attempt, ending in exactly one completion or failure event. */
  run(context: AttemptLaunchContext): AsyncIterable<AttemptEvent>;
}
