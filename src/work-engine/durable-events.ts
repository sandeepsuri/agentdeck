// Ticket 06: the durable event envelope every AttemptEvent (ticket 05) is
// wrapped in before it is written to the Attempt event log. The envelope —
// not the shared AttemptEvent shape adapter.contract.ts guards — is where
// persistence-layer metadata belongs: which Run and Attempt it is ordered
// within, how to correlate it with the rest of that Attempt's history, an
// opaque identity a redelivered provider notification will reproduce
// exactly (so a reconnect never duplicates durable history), a schema
// version for future envelope changes, and a durability classification.
import { createHash } from 'node:crypto';
import { ATTEMPT_EVENT_FIELDS } from './types.js';
import type { AttemptEvent } from './types.js';

export type EventDurabilityClass = 'durable' | 'transient';

// Every AttemptEvent kind the shared runtime-adapter contract can produce
// today is a fully-formed, final fact, never a partial delta — Codex's own
// adapter only ever translates a *completed* item into a `message` or
// `tool-activity` event (see runtimes/codex.ts's item/completed handling);
// raw PTY bytes and incremental message deltas have no representation in
// AttemptEvent at all. If a future runtime adapter ever needs to stream
// either, it must arrive as its own kind classified 'transient' here (or as
// a compacted attachment) — never smuggled in as one of the kinds below.
//
// Ticket 07: 'attention-requested'/'attention-resolved' are durable for the
// same reason — each is one final fact (a request was made; it was
// resolved this way), never a delta — which is what lets a restart tell a
// denied/resolved/expired request apart from one still pending without
// ever reopening it (see recovery.ts and engine.ts's resolveAttention).
//
// Ticket 08: 'verification-check' and 'verification-outcome' are durable for
// the same reason again — each gate result and the final verification
// outcome are final facts (AC4's "durable command and result evidence"),
// never deltas.
//
// Ticket 09: 'budget-exceeded', 'pause-requested', 'paused', and 'resumed'
// are durable for the same reason once more — each is one final fact (a
// hard limit was hit; a pause was requested/took effect/was lifted), which
// is what lets a restart tell "paused, waiting to resume" apart from
// "cancelled" or "never asked to pause at all" (AC6's restart-durability
// bar) instead of ever guessing.
//
// Ticket 10: 'commit-created'/'commit-failed' are durable once more — the
// one, final fact of how the delivery commit went, part of the durable Run
// result (AC4).
const DURABLE_ATTEMPT_EVENT_KINDS: ReadonlySet<AttemptEvent['kind']> = new Set([
  'lifecycle', 'message', 'tool-activity', 'usage', 'completion', 'failure',
  'attention-requested', 'attention-resolved', 'verification-check', 'verification-outcome',
  'budget-exceeded', 'pause-requested', 'paused', 'resumed', 'commit-created', 'commit-failed',
]);

export function classifyEventDurability(kind: AttemptEvent['kind']): EventDurabilityClass {
  return DURABLE_ATTEMPT_EVENT_KINDS.has(kind) ? 'durable' : 'transient';
}

// ATTEMPT_EVENT_FIELDS (types.ts) is also what adapter.contract.ts's
// runtime-adapter contract tests check every adapter's output against —
// reusing it here is ticket 06 AC8's defense in depth at the persistence
// boundary itself: even a future bug that attaches something extra to an
// event object (a provider id, a credential) cannot reach durable storage,
// because sanitizeAttemptEvent below strips it first.
function sanitizeAttemptEvent(event: AttemptEvent): AttemptEvent {
  const allowed: readonly string[] = ATTEMPT_EVENT_FIELDS[event.kind] ?? [];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (allowed.includes(key)) sanitized[key] = value;
  }
  return sanitized as unknown as AttemptEvent;
}

/** Bumped only if the envelope's own metadata shape changes — never by AttemptEvent's shape, which adapter.contract.ts guards. */
export const ATTEMPT_EVENT_ENVELOPE_SCHEMA_VERSION = 1;

export interface AttemptEventEnvelope {
  readonly runId: string;
  readonly attemptId: string;
  /** Same value as event.sequence — the ordering contract, restated at the envelope so persistence never has to reach into the payload for it. */
  readonly sequence: number;
  readonly correlationId: string;
  /**
   * Provider-deduplication identity: a hash of the event's content, excluding
   * its own sequence and timestamp (both of which a redelivered provider
   * notification would regenerate rather than reproduce). Appending an event
   * whose dedupeKey already exists for this Attempt is defined as a no-op.
   */
  readonly dedupeKey: string;
  readonly at: string;
  readonly schemaVersion: number;
  readonly durability: EventDurabilityClass;
  readonly event: AttemptEvent;
}

function dedupeIdentity(scope: string, event: AttemptEvent): string {
  const stable: Record<string, unknown> = { ...event };
  delete stable.sequence;
  delete stable.at;
  const canonical = Object.keys(stable).sort()
    .map((key) => `${key}=${JSON.stringify(stable[key])}`)
    .join('&');
  return createHash('sha256').update(`${scope} ${canonical}`).digest('hex');
}

export interface BuildAttemptEventEnvelopeParams {
  readonly runId: string;
  readonly attemptId: string;
  readonly event: AttemptEvent;
  /**
   * Ticket 08: what "the same event redelivered" is scoped to — defaults to
   * `attemptId`, exactly ticket 06/07's original behavior for a single
   * adapter invocation, where two structurally-identical events truly are
   * the same provider notification redelivered after a reconnect. A repair
   * round (engine.ts's runVerification) is a *fresh* adapter invocation, not
   * a redelivery — passing a round-specific scope there (e.g. `repair-1`;
   * it need not repeat `attemptId` itself, since attempt_events' own
   * `UNIQUE (attempt_id, dedupe_key)` constraint already scopes uniqueness
   * per Attempt) is what lets its own 'attempt-started' lifecycle event, or
   * a gate that fails with byte-identical evidence twice in a row, persist
   * as its own real event instead of being silently dropped as a
   * false-positive duplicate of an earlier round's
   * structurally-identical one.
   */
  readonly dedupeScope?: string;
}

export function buildAttemptEventEnvelope(params: BuildAttemptEventEnvelopeParams): AttemptEventEnvelope {
  const { runId, attemptId } = params;
  const event = sanitizeAttemptEvent(params.event);
  return {
    runId,
    attemptId,
    sequence: event.sequence,
    correlationId: `${runId}:${attemptId}`,
    dedupeKey: dedupeIdentity(params.dedupeScope ?? attemptId, event),
    at: event.at,
    schemaVersion: ATTEMPT_EVENT_ENVELOPE_SCHEMA_VERSION,
    durability: classifyEventDurability(event.kind),
    event,
  };
}
