// Boot-time session reconciliation (ticket 04, extended by ticket 09).
// Managed processes die with the server that spawned them, so no PTY
// survives a restart — but an already-ended session (from a graceful
// stop/exit before the restart) must keep its row and its original
// endedAt, per "ended sessions survive a server restart".
import type { Store } from '../store/index.js';
import { compactOrphanedRawLog } from '../sessions/transcript.js';

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
 *
 * Ticket 09: a raw.log with no matching scrollback.txt means the server
 * was killed hard enough (e.g. `kill -9` on the whole process) that
 * SessionManager.handleExit — and therefore SessionTranscript.close() —
 * never ran for that session, leaving it unreadable. No PTY survives a
 * restart, so any raw.log found here, for any managed session, is
 * guaranteed orphaned rather than belonging to a still-live process; boot
 * is the first safe point to catch it. compactOrphanedRawLog() is a no-op
 * (cheap ENOENT) for the normal case where the session already compacted
 * cleanly on exit.
 */
export async function reconcileSessionsOnBoot(store: Store, sessionsDir: string): Promise<void> {
  const now = new Date().toISOString();
  for (const session of store.listSessions()) {
    if (session.origin !== 'managed') continue;
    if (session.status !== 'exited') {
      session.status = 'exited';
      session.statusSource = 'process_gone';
      session.endedAt = now;
      store.upsertSession(session);
    }
    try {
      await compactOrphanedRawLog(sessionsDir, session.id);
    } catch (error) {
      console.error(`[agentdeck] failed to compact orphaned output for session ${session.id}:`, error);
    }
  }
}
