import type { SessionManager } from '../sessions/manager.js';
import type { WakeLock } from './wake-lock.js';

/** Keeps the machine awake exactly while at least one managed PTY is live. */
export function coordinateManagedWakeLock(manager: SessionManager, wakeLock: WakeLock): () => void {
  const recompute = () => {
    const liveManagedCount = manager.listSessions()
      .filter((session) => session.origin === 'managed' && session.status !== 'exited')
      .length;
    wakeLock.update(liveManagedCount);
  };
  manager.on('session_update', recompute);
  manager.on('session_removed', recompute);
  recompute();

  return () => {
    manager.off('session_update', recompute);
    manager.off('session_removed', recompute);
    wakeLock.release();
  };
}
