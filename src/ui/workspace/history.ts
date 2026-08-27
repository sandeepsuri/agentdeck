import type { Session } from '../../types.js';
import { isEndedSession } from './model.js';

/** Ended sessions stay in the rail for roughly an hour before aging into History. */
export const RAIL_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * Design note — the "restart vs. grace period" ambiguity (ticket 10).
 *
 * "Stays in the rail ~1h, then moves to History" and "restarting the
 * workspace moves ended sessions to History immediately" read as
 * contradictory under pure elapsed-time-since-`endedAt` bucketing: a
 * session that ended 5 minutes before a restart would, by elapsed time
 * alone, still have 55 minutes of rail time left afterward.
 *
 * Resolved with the client-witnessed-transition model: the grace period
 * applies only to a session THIS client actually watched go from live to
 * ended while connected (i.e. it held the session in the rail as live, then
 * received an update marking it ended). A session that is already `exited`
 * in the very first sessions list a client sees — a fresh page load, or the
 * fresh GET/WS-reconnect that follows a server restart — never had a
 * witnessed transition, so it goes straight to History with no grace
 * period. This is pure client-side bookkeeping; it needs no server "boot
 * time" field, because the server already keeps every ended managed
 * session indefinitely (ticket 04) rather than deleting it at boot, so a
 * freshly-reconnected client cannot tell "server restarted" apart from
 * "I just opened this page" — and it doesn't need to: both cases mean the
 * client never witnessed the ending, so both land in History immediately.
 */
export function isInHistory(
  session: Session,
  now: number,
  witnessedEndedAtById: ReadonlyMap<string, number>,
): boolean {
  if (!isEndedSession(session)) return false;
  const witnessedAt = witnessedEndedAtById.get(session.id);
  if (witnessedAt === undefined) return true;
  return now - witnessedAt >= RAIL_GRACE_PERIOD_MS;
}

/**
 * Bookkeeping `isInHistory` needs beyond a single session snapshot: which
 * session ids this client has actually watched go from live to ended, and
 * when. Immutable in, immutable out, so it can be threaded through repeated
 * calls (once per sessions-list update) without any hidden state.
 */
export interface HistoryWitnessState {
  /** Managed session ids currently known to be live (not yet ended). */
  liveSeenIds: ReadonlySet<string>;
  /** Session id -> the local clock reading when this client saw it end. */
  witnessedEndedAtById: ReadonlyMap<string, number>;
}

export const INITIAL_HISTORY_WITNESS_STATE: HistoryWitnessState = {
  liveSeenIds: new Set(),
  witnessedEndedAtById: new Map(),
};

/**
 * Advances the witness bookkeeping given the latest sessions snapshot.
 * Idempotent for a stable `sessions` snapshot: calling it again with the
 * same sessions (and a different `now`) does not move an already-recorded
 * witnessed-ended timestamp, so it is safe to call on every render rather
 * than only from an effect — recording the transition in the same render
 * it is first observed avoids a one-render lag that would otherwise let a
 * just-ended session flash into History before settling back into its
 * grace period.
 */
export function advanceHistoryWitnessState(
  state: HistoryWitnessState,
  sessions: readonly Session[],
  now: number,
): HistoryWitnessState {
  const liveSeenIds = new Set(state.liveSeenIds);
  const witnessedEndedAtById = new Map(state.witnessedEndedAtById);
  const presentIds = new Set(sessions.map((session) => session.id));

  for (const id of liveSeenIds) if (!presentIds.has(id)) liveSeenIds.delete(id);
  for (const id of witnessedEndedAtById.keys()) if (!presentIds.has(id)) witnessedEndedAtById.delete(id);

  for (const session of sessions) {
    if (isEndedSession(session)) {
      if (!witnessedEndedAtById.has(session.id) && liveSeenIds.has(session.id)) {
        witnessedEndedAtById.set(session.id, now);
      }
      liveSeenIds.delete(session.id);
    } else if (session.origin === 'managed') {
      liveSeenIds.add(session.id);
    }
  }

  return { liveSeenIds, witnessedEndedAtById };
}

/**
 * Splits the full session list into the rail bucket (live sessions, plus
 * ended sessions still within their grace period) and the History bucket
 * (ended sessions that have aged out, or were never witnessed ending).
 * Order is preserved within each bucket.
 */
export function splitSessionsForRail(
  sessions: readonly Session[],
  now: number,
  witnessedEndedAtById: ReadonlyMap<string, number>,
): { rail: Session[]; history: Session[] } {
  const rail: Session[] = [];
  const history: Session[] = [];
  for (const session of sessions) {
    (isInHistory(session, now, witnessedEndedAtById) ? history : rail).push(session);
  }
  return { rail, history };
}
