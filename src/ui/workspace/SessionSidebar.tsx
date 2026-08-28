import type { DiscoveryStatus, Repo, Session } from '../../types.js';
import { SparkBars, StatusBadge, isEndedSession, sessionLabel } from './model.js';

interface Props {
  sessions: Session[];
  repos: Repo[];
  selectedId: string | null;
  discoveryStatus: DiscoveryStatus | null;
  onSelect: (session: Session) => void;
  onLaunch: () => void;
  onRefreshDiscovery: () => void;
}

function SessionRow({ session, index, selected, onSelect }: {
  session: Session;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ended = isEndedSession(session);
  return (
    <button className={`session-row${selected ? ' is-selected' : ''}${ended ? ' is-ended' : ''}`} onClick={onSelect} type="button">
      <span className={`session-selection-rail status-${session.status}`} />
      <span className="session-row-content">
        <span className="session-row-title">
          <span title={sessionLabel(session)}>{sessionLabel(session)}</span>
          <StatusBadge status={session.status} />
        </span>
        <span className="session-row-subtitle">
          {session.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} · {session.cwd.split('/').pop() ?? session.cwd}
          {session.branch ? ` / ${session.branch}` : ''}
        </span>
        {/* A live-activity graph would be misleading for a dead process:
            show it only while the session is actually running. */}
        {session.origin === 'managed' && !ended && <SparkBars active={selected} count={20} seed={index + 1} />}
        {ended && (
          <span className="session-row-ended">
            Ended {new Date(session.endedAt ?? session.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </span>
      {session.origin === 'external' && <span className="external-arrow">↗</span>}
      <span className="session-key">{index < 9 ? index + 1 : ''}</span>
    </button>
  );
}

export function SessionSidebar({
  sessions,
  repos,
  selectedId,
  discoveryStatus,
  onSelect,
  onLaunch,
  onRefreshDiscovery,
}: Props) {
  const managed = sessions.filter((session) => session.origin === 'managed');
  const discovered = sessions.filter((session) => session.origin === 'external');

  return (
    <aside className="session-sidebar">
      <div className="control-plane-card">
        <span className="control-plane-mark">⌁</span>
        <span>
          <strong>Control plane</strong>
          <small>localhost:4040</small>
        </span>
        <span className="app-version">v0.1.0</span>
      </div>

      <div className="session-list">
        <div className="sidebar-section-label">
          <span>Managed</span><span>{managed.length}</span>
        </div>
        {managed.map((session, index) => (
          <SessionRow
            index={index}
            key={session.id}
            onSelect={() => onSelect(session)}
            selected={session.id === selectedId}
            session={session}
          />
        ))}
        {managed.length === 0 && <div className="sidebar-empty">No managed sessions</div>}

        <div className="sidebar-section-label sidebar-discovered-label">
          <span>Discovered</span><span>{discovered.length}</span>
        </div>
        {discovered.map((session, index) => (
          <SessionRow
            index={managed.length + index}
            key={session.id}
            onSelect={() => onSelect(session)}
            selected={session.id === selectedId}
            session={session}
          />
        ))}
        {discovered.length === 0 && (
          <button className="sidebar-empty sidebar-empty-action" disabled={discoveryStatus?.polling} onClick={onRefreshDiscovery} type="button">
            {discoveryStatus?.polling ? 'Scanning terminals…' : 'No external sessions · rescan'}
          </button>
        )}
      </div>

      <div className="sidebar-footer-meta">
        <span>{repos.length} repositories</span>
        <span>{sessions.length} sessions</span>
      </div>
      <button className="new-session-button" onClick={onLaunch} type="button">＋ New session</button>
    </aside>
  );
}
