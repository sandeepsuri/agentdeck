import type { Session } from '../../types.js';

/**
 * A managed session's terminal view (xterm instance + WS attach) is worth
 * keeping mounted only while the session itself is still live. `handleExit`
 * (src/sessions/manager.ts) deletes the session and emits `session_removed`
 * synchronously, so "still live" reduces to "still present, non-exited, in
 * the sessions list" — there is no separate wire moment where a session sits
 * in the list with status `exited`, but we check status too as a defensive
 * second signal.
 */
function isLiveManaged(session: Session): boolean {
  return session.origin === 'managed' && session.status !== 'exited';
}

/**
 * Computes which session ids should stay mounted as `<Terminal>` views,
 * given the ids currently mounted, the latest session list, and the id the
 * viewer has selected (if any managed session is selected and attachable).
 *
 * - Ids whose session has ended or disappeared are dropped (their `Terminal`
 *   unmounts, disposing the xterm instance and detaching the WS).
 * - The selected id is added if it names a live managed session and isn't
 *   already mounted.
 * - Everything else already mounted stays mounted, so switching back to a
 *   previously viewed session is a pure visibility toggle, not a remount.
 */
export function nextMountedTerminalIds(
  currentIds: readonly string[],
  sessions: readonly Session[],
  selectableId: string | null,
): string[] {
  const liveById = new Map(sessions.filter(isLiveManaged).map((session) => [session.id, session]));
  const kept = currentIds.filter((id) => liveById.has(id));
  if (selectableId && liveById.has(selectableId) && !kept.includes(selectableId)) {
    return [...kept, selectableId];
  }
  return kept;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Derives a React `key` per mounted session id, combining `id` with the
 * session's `startedAt`. `SessionManager.restart` keeps a session's `id` but
 * assigns a fresh `startedAt` and a brand-new (empty) transcript, so the old
 * mounted `<Terminal>` for that id is showing stale pre-restart scrollback
 * and needs a clean unmount+remount to re-attach and replay the new
 * transcript — it must NOT just keep receiving appended output. Keying the
 * `<Terminal>` itself (not its wrapping `.terminal-view` slot, which must
 * stay put so the CSS visibility toggle keeps working) on this value forces
 * exactly that remount when `startedAt` changes, while leaving every other
 * mounted session's view untouched.
 *
 * Falls back to the bare id if the session is momentarily missing from
 * `sessions` (e.g. the render right before pruning catches up).
 */
export function terminalViewKeys(
  ids: readonly string[],
  sessions: readonly Session[],
): Record<string, string> {
  const startedAtById = new Map(sessions.map((session) => [session.id, session.startedAt]));
  const keys: Record<string, string> = {};
  for (const id of ids) {
    const startedAt = startedAtById.get(id);
    keys[id] = startedAt ? `${id}-${startedAt}` : id;
  }
  return keys;
}
