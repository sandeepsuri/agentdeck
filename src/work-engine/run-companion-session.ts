// Ticket 68 (B13, docs/specs/run-execution-terminal-capabilities.md): a
// live, read-only, admin-only correlation between a Run's prepared worktree
// and any already-independently-existing Session (managed or external)
// that happens to share it. Deliberately advisory, not a claim of process
// identity — no structured Attempt has ever created an attachable terminal
// (see the design doc's own findings), so this never says "this is the
// Run's terminal," only "a Session is currently open in this worktree."
//
// Derived on every read, never stored: nothing today creates a Session
// when an Attempt starts, so there is no natural write site for a stored
// link, and a stored link would need reconciliation logic (the Session
// ending, being deleted, or a second match appearing) that a fresh query
// simply doesn't have.
import type {
  AgentType, Session, SessionOrigin, SessionStatus,
} from '../types.js';
import type { WorkRun } from './types.js';

/** A Session found to share a Run's prepared worktree — advisory, never a claim of process identity. */
export interface RunCompanionSessionRef {
  readonly sessionId: string;
  readonly origin: SessionOrigin;
  readonly agent: AgentType;
  readonly status: SessionStatus;
  /** True once the Session's own worktreePath/cwd names this Run's exact prepared worktree; false when only the looser same-Repository match applied. */
  readonly exactWorktreeMatch: boolean;
}

/**
 * Every currently-known Session whose location names the same worktree as
 * `run`'s own prepared one — never a single "the" companion, since more
 * than one terminal can legitimately be open in the same worktree doing
 * unrelated things. Empty when the worktree isn't prepared yet
 * (`preparation.state !== 'ready'`) or when nothing matches, the ordinary
 * case for most Runs. Performs no authority filtering of its own — the
 * caller passes only Sessions it already has standing to see.
 */
export function deriveRunCompanionSessions(
  run: WorkRun,
  sessions: readonly Session[],
): readonly RunCompanionSessionRef[] {
  const { worktreePath } = run.preparation;
  if (run.preparation.state !== 'ready' || !worktreePath) return [];

  return sessions.flatMap((session) => {
    const exactWorktreeMatch = session.worktreePath === worktreePath || session.cwd === worktreePath;
    const sameRepository = session.repoId === run.spec.repository.id;
    if (!exactWorktreeMatch && !sameRepository) return [];
    return [{
      sessionId: session.id,
      origin: session.origin,
      agent: session.agent,
      status: session.status,
      exactWorktreeMatch,
    }];
  });
}
