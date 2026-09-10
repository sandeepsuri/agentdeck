// Ticket 06 AC5/AC7: what happens to a Run whose Attempt was interrupted by
// a restart. No live process (and no in-memory task) for that Attempt
// survives the restart — and AgentDeck deliberately never persists what a
// runtime needs to resume a specific prior provider conversation (ticket
// 05: "Provider conversation identity remains inside the adapter and is not
// used as the AgentDeck Run identity"). So there is currently no state from
// which a restart could safely reattach or resume, regardless of what the
// installed CLI itself reports supporting — continuation is always
// impossible today. This module turns that fact into one precise,
// deterministic, human-readable reason instead of leaving the Run stuck in
// 'running' forever. Nothing here re-invokes a runtime adapter: recovery
// only ever records a terminal fact, never replays one.
import type { RuntimeReadinessReport } from '../sessions/runtime-readiness.js';
import type { AgentType } from '../types.js';
import { derivePauseState } from './attempt-projection.js';
import type { AttemptEvent } from './types.js';

/**
 * When the last durable event is a tool-activity that started but never
 * reported completion or failure, its outcome is genuinely unknown — the
 * crash could have landed before or after the tool's real-world side
 * effect. That ambiguity is stated plainly rather than guessed at; the
 * event itself is left exactly as recorded, never rewritten to a guessed
 * 'completed' or 'failed'.
 */
function describeAmbiguousActivity(events: readonly AttemptEvent[]): string | undefined {
  const last = events.at(-1);
  if (last?.kind !== 'tool-activity' || last.status !== 'started') return undefined;
  const detail = last.summary ? `: ${last.summary}` : '';
  return `The last recorded activity (${last.tool}${detail}) never reported completion or failure before the `
    + 'restart — its outcome is unknown and was not assumed.';
}

/**
 * Ticket 07 AC4: a Run left waiting on an approval or input request when the
 * previous process stopped has no live Attempt task to hand a decision to
 * (DurableWorkEngine.liveAttempts starts empty every boot) — the same "no
 * live process, no in-memory task" fact recover()'s own header comment
 * already states for every other 'running' Attempt. This only makes that
 * fact concrete in the reason text; the request itself is never rewritten
 * to a guessed outcome, and once this failure event is appended,
 * deriveOpenAttentionRequest (attempt-projection.ts) stops surfacing it as
 * pending at all — so resolveAttention() naturally refuses it afterward
 * (RunAttentionNotPendingError) instead of ever reopening it.
 */
function describePendingAttention(events: readonly AttemptEvent[]): string | undefined {
  const last = events.at(-1);
  if (last?.kind !== 'attention-requested') return undefined;
  return `The Attempt was waiting on ${last.attentionKind === 'approval' ? 'an approval' : 'an input'} `
    + `request (${last.reason}) that was never resolved before the restart.`;
}

/**
 * Ticket 08 AC8, extended to restart: a trailing 'completion' event (the
 * runtime finished) or 'verification-check' event (a repair round's gates
 * are being re-checked) with no matching 'verification-outcome' means
 * verification never concluded — no live process survives the restart to
 * finish running gate commands, so this is stated plainly rather than ever
 * assumed to have passed (see projectAttemptState, which reports these same
 * Attempts as still 'running' for exactly this reason).
 */
function describeUnverifiedCompletion(events: readonly AttemptEvent[]): string | undefined {
  const last = events.at(-1);
  if (last?.kind !== 'completion' && last?.kind !== 'verification-check') return undefined;
  return 'The runtime reported completion, but AgentDeck restarted before its changes could be verified — no '
    + 'live process remains to finish that check, so the outcome is not assumed.';
}

/**
 * Ticket 09 AC6: a pause that was requested or had already taken effect is
 * folded from the whole event log (derivePauseState), not just the trailing
 * event — a still-live round can append ordinary progress events on top of
 * an outstanding 'pause-requested' before the restart lands. Restart ends
 * the Attempt precisely either way (no live process survives to honor the
 * pause or resume it later), but the reason says so plainly rather than
 * describing it as an ordinary interruption.
 */
function describePausedAttempt(events: readonly AttemptEvent[]): string | undefined {
  const pause = derivePauseState(events);
  if (pause === 'none') return undefined;
  return pause === 'paused'
    ? 'The Attempt was paused, waiting to be resumed, when the restart happened.'
    : 'A pause had been requested but never reached a safe boundary to take effect before the restart.';
}

/** Whether the installed runtime's own CLI reports structured continuation support — never, by itself, whether resuming is actually safe (see describeUnrecoverableAttempt). */
export function isContinuationSupported(readiness: RuntimeReadinessReport, runtime: AgentType): boolean {
  const runtimeReadiness = readiness.runtimes.find((candidate) => candidate.runtime === runtime);
  return runtimeReadiness?.capabilities
    .some((capability) => capability.capability === 'continuation' && capability.supported) ?? false;
}

export function describeUnrecoverableAttempt(
  runtime: AgentType,
  readiness: RuntimeReadinessReport,
  events: readonly AttemptEvent[],
): string {
  const runtimeReadiness = readiness.runtimes.find((candidate) => candidate.runtime === runtime);
  const displayName = runtimeReadiness?.displayName ?? runtime;
  const continuationSupported = isContinuationSupported(readiness, runtime);
  const base = continuationSupported
    ? `AgentDeck restarted before this Attempt finished. ${displayName} reports structured continuation `
      + 'support, but AgentDeck never persists what a runtime needs to resume a specific prior conversation, '
      + 'so resuming it safely is not possible.'
    : `AgentDeck restarted before this Attempt finished, and ${displayName} does not support structured `
      + 'continuation, so it cannot be resumed.';
  const ambiguous = describeAmbiguousActivity(events);
  if (ambiguous) return `${base} ${ambiguous}`;
  const pendingAttention = describePendingAttention(events);
  if (pendingAttention) return `${base} ${pendingAttention}`;
  const unverifiedCompletion = describeUnverifiedCompletion(events);
  if (unverifiedCompletion) return `${base} ${unverifiedCompletion}`;
  const paused = describePausedAttempt(events);
  return paused ? `${base} ${paused}` : base;
}
