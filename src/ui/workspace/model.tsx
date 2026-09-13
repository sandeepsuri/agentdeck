import { useEffect, useState } from 'react';
import type { Repo, Session, SessionStatus } from '../../types.js';

/** Redesign spec §03: the four primary destinations. Settings is a separate layer, not a view. */
export type WorkspaceView = 'home' | 'work' | 'review' | 'usage';

export const WORKSPACE_VIEWS: { id: WorkspaceView; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'work', label: 'Work' },
  { id: 'review', label: 'Review' },
  { id: 'usage', label: 'Usage' },
];

export const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting_input: 'Waiting',
  idle: 'Idle',
  completed: 'Complete',
  exited: 'Exited',
  unknown: 'Unknown',
};

/** Every Session state, shared by admin and collaborator filters so the two projections cannot drift. */
export const SESSION_STATUS_OPTIONS: readonly SessionStatus[] = [
  'starting', 'working', 'waiting_input', 'idle', 'completed', 'exited', 'unknown',
];

/**
 * True for a managed session whose process has exited. It stays listed
 * (ticket 04: ended sessions are kept, not deleted) but has no live PTY
 * behind it, so live-only actions (stop, restart, sending input) are
 * unavailable and it should read as visually distinct from a running one.
 * "Ended" is a managed-session concept only — external sessions have no
 * kept history and simply disappear once their process is gone.
 */
export function isEndedSession(session: Session): boolean {
  return session.origin === 'managed' && session.status === 'exited';
}

export function sessionLabel(session: Session): string {
  return session.name ?? `${session.agent === 'claude' ? 'Claude' : 'Codex'} · ${session.cwd.split('/').pop() ?? session.cwd}`;
}

export function repoPathOf(session: Session): string {
  return session.worktreePath ?? session.repoId ?? session.cwd;
}

/** Human-readable repository name for a session, resolved against the known repos list. */
export function repoDisplayName(session: Session, repos: readonly Repo[]): string {
  const path = repoPathOf(session);
  return repos.find((repo) => repo.id === path || repo.path === path)?.name
    ?? session.cwd.split('/').pop()
    ?? session.cwd;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Ticket 53 (B19): a narrative step's actual event time, rendered
 * accessibly — never fabricated. Absent or unparseable `at` (a legacy step,
 * a step that predates this field) returns `undefined` rather than a
 * placeholder, so the caller can simply omit the time instead of showing a
 * misleading one. `title` carries the full date and time zone for a screen
 * reader or hover, while `label` stays short enough to sit next to the step.
 */
export function narrativeStepTime(at: string | undefined): { iso: string; label: string; title: string } | undefined {
  if (at === undefined) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    iso: at,
    label: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    title: date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'long' }),
  };
}

export function elapsedTime(startedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

/**
 * Ticks once per `intervalMs` and returns the current timestamp, causing only
 * the calling component to re-render. Use this instead of threading a `now`
 * prop down from a shared ancestor — that would re-render the whole subtree
 * every tick just to keep one clock or elapsed-time display current.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Leaf component that renders a session's elapsed time and ticks itself. */
export function ElapsedTime({ startedAt }: { startedAt: string }) {
  const now = useNow(1000);
  return <>{elapsedTime(startedAt, now)}</>;
}

export function StatusLamp({ status, pulse = false }: { status: SessionStatus; pulse?: boolean }) {
  return <span aria-label={STATUS_LABELS[status]} className={`status-lamp status-${status}${pulse ? ' is-pulsing' : ''}`} />;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}

/** A calm, people-facing duration: "now", "52m", "1h 22m", "3d 4h". */
export function durationLabel(startedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Leaf component so only the duration text re-renders each minute. */
export function Duration({ since }: { since: string }) {
  const now = useNow(30_000);
  return <>{durationLabel(since, now)}</>;
}
