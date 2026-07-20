import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repo, Session } from '../../types.js';
import { sessionLabel, type WorkspaceView, WORKSPACE_VIEWS } from './model.js';

interface Props {
  open: boolean;
  sessions: Session[];
  repos: Repo[];
  onClose: () => void;
  onLaunch: () => void;
  onSelectSession: (session: Session) => void;
  onView: (view: WorkspaceView) => void;
}

export function CommandPalette({ open, sessions, repos, onClose, onLaunch, onSelectSession, onView }: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const normalized = query.trim().toLowerCase();
  const visibleSessions = useMemo(() => sessions.filter((session) =>
    !normalized || `${sessionLabel(session)} ${session.cwd} ${session.branch ?? ''} ${session.agent}`.toLowerCase().includes(normalized)), [normalized, sessions]);
  const visibleViews = WORKSPACE_VIEWS.filter((view) => !normalized || view.label.toLowerCase().includes(normalized));

  if (!open) return null;
  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <section aria-label="Command palette" aria-modal="true" className="command-palette" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <div className="palette-input"><span>&gt;_</span><input ref={inputRef} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Jump to session, file, or action…" value={query} /><kbd>ESC</kbd></div>
        <div className="palette-results">
          <div className="sidebar-section-label"><span>Actions</span></div>
          {(!normalized || 'launch new session'.includes(normalized)) && <button onClick={() => { onClose(); onLaunch(); }} type="button"><span>＋</span><strong>Launch new session</strong><kbd>⌘L</kbd></button>}
          {visibleViews.map((view) => <button key={view.id} onClick={() => { onView(view.id); onClose(); }} type="button"><span>⌘</span><strong>Open {view.label}</strong></button>)}
          <div className="sidebar-section-label"><span>Sessions</span><span>{visibleSessions.length}</span></div>
          {visibleSessions.map((session) => <button key={session.id} onClick={() => { onSelectSession(session); onClose(); }} type="button"><span>{session.agent === 'claude' ? 'C' : '⌘'}</span><strong>{sessionLabel(session)}<small>{session.cwd}{session.branch ? ` · ${session.branch}` : ''}</small></strong><em>{session.status.replaceAll('_', ' ')}</em></button>)}
          {normalized && visibleSessions.length === 0 && visibleViews.length === 0 && <div className="palette-empty">No sessions, repositories, or actions match “{query}”.</div>}
        </div>
        <footer><span>↑↓ Navigate</span><span>↵ Open</span><span>{repos.length} repositories indexed</span></footer>
      </section>
    </div>
  );
}
