// Boot-time session reconciliation (ticket 04). Managed processes die with
// the server that spawned them, so no PTY survives a restart — but an
// already-ended session (from a graceful stop/exit before the restart)
// must keep its row and its original endedAt, per "ended sessions survive
// a server restart".
import type { Store } from '../store/index.js';

/**
 * Runs once at boot, before any managed session can be relaunched.
 *
 * - A managed session that was still live (starting/working/waiting_input/
 *   idle/completed/unknown) when the previous process died has no PTY to
 *   resume: it is marked 'exited' now, with endedAt set to this moment —
 *   the earliest point at which the new process can know it's gone.
 * - A managed session already 'exited' keeps its row and its original
 *   endedAt untouched.
 * - External (discovered) sessions are left alone: they have no managed
 *   lifecycle here, and DiscoveryPoller re-scans and reconciles them
 *   (removing ones no longer present) as soon as it starts.
 */
export function reconcileSessionsOnBoot(store: Store): void {
  const now = new Date().toISOString();
  for (const session of store.listSessions()) {
    if (session.origin !== 'managed' || session.status === 'exited') continue;
    session.status = 'exited';
    session.statusSource = 'process_gone';
    session.endedAt = now;
    store.upsertSession(session);
  }
}
