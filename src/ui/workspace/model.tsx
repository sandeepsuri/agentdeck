import { useEffect, useState } from 'react';
import type { Repo, Session, SessionStatus } from '../../types.js';

export type WorkspaceView = 'operations' | 'terminal' | 'changes' | 'grid' | 'signals' | 'history';

export const WORKSPACE_VIEWS: { id: WorkspaceView; label: string }[] = [
  { id: 'operations', label: 'Operations' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'changes', label: 'Changes' },
  { id: 'grid', label: 'Grid' },
  { id: 'history', label: 'History' },
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

export function SparkBars({ seed, active = false, count = 18 }: { seed: number; active?: boolean; count?: number }) {
  return (
    <span aria-hidden="true" className={`spark-bars${active ? ' is-active' : ''}`}>
      {Array.from({ length: count }, (_, index) => {
        const height = 3 + Math.abs(Math.sin(seed * 7.3 + index * 1.7) * Math.cos(seed + index * 0.61)) * 10;
        return <i key={index} style={{ height }} />;
      })}
    </span>
  );
}
