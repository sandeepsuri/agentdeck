import { useEffect, useMemo, useState } from 'react';
import type { Repo, Session } from '../../types.js';
import { repoDisplayName, sessionLabel } from './model.js';

interface Props {
  /** Ended managed sessions that have aged out of the rail (see history.ts). */
  sessions: Session[];
  repos: Repo[];
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Fetches and renders the compacted scrollback for one ended session (ticket 09's endpoint). */
function HistoryScrollback({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<{ loading: boolean; scrollback: string | null; error: string | null }>({
    loading: true, scrollback: null, error: null,
  });

  useEffect(() => {
    let disposed = false;
    setState({ loading: true, scrollback: null, error: null });
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/scrollback`)
      .then(async (response) => {
        const body = await response.json() as { scrollback?: string; error?: string };
        if (disposed) return;
        if (!response.ok) { setState({ loading: false, scrollback: null, error: body.error ?? 'Unable to load scrollback.' }); return; }
        setState({ loading: false, scrollback: body.scrollback ?? '', error: null });
      })
      .catch(() => { if (!disposed) setState({ loading: false, scrollback: null, error: 'Unable to load scrollback.' }); });
    return () => { disposed = true; };
  }, [sessionId]);

  if (state.loading) return <div className="history-scrollback-empty">Loading scrollback…</div>;
  if (state.error) return <div className="history-scrollback-empty">{state.error}</div>;
  if (!state.scrollback) return <div className="history-scrollback-empty">This session produced no output.</div>;
  return <pre className="history-scrollback-text">{state.scrollback}</pre>;
}

export function HistoryView({ sessions, repos }: Props) {
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.endedAt ?? b.lastActivityAt).getTime() - new Date(a.endedAt ?? a.lastActivityAt).getTime()),
    [sessions],
  );
  const [selectedId, setSelectedId] = useState<string | null>(ordered[0]?.id ?? null);

  useEffect(() => {
    if (selectedId && ordered.some((session) => session.id === selectedId)) return;
    setSelectedId(ordered[0]?.id ?? null);
  }, [ordered, selectedId]);

  const selected = ordered.find((session) => session.id === selectedId) ?? null;

  if (ordered.length === 0) {
    return (
      <div className="empty-workspace">
        <strong>No history yet</strong>
        <span>Ended sessions move here after roughly an hour in the rail, or immediately after a restart.</span>
      </div>
    );
  }

  return (
    <section className="history-workspace">
      <aside className="history-list">
        <div className="sidebar-section-label"><span>Ended sessions</span><span>{ordered.length}</span></div>
        {ordered.map((session) => (
          <button
            className={`history-row${session.id === selectedId ? ' is-selected' : ''}`}
            key={session.id}
            onClick={() => setSelectedId(session.id)}
            type="button"
          >
            <strong title={sessionLabel(session)}>{sessionLabel(session)}</strong>
            <span>{repoDisplayName(session, repos)}{session.branch ? ` / ${session.branch}` : ''}</span>
            <small>{session.endedAt ? formatTime(session.endedAt) : '—'}</small>
          </button>
        ))}
      </aside>
      <div className="history-detail">
        {selected ? (
          <>
            <header className="history-detail-header">
              <h2>{sessionLabel(selected)}</h2>
              <div className="history-detail-meta">
                <span>{repoDisplayName(selected, repos)}</span>
                <span>{selected.branch ?? 'Unknown branch'}</span>
                <span>Started {formatDateTime(selected.startedAt)}</span>
                <span>Ended {selected.endedAt ? formatDateTime(selected.endedAt) : 'unknown'}</span>
              </div>
            </header>
            {/* Extension point for ticket 11's wrap-up summary — intentionally
                left absent here; that ticket owns the summarize button/panel. */}
            <div className="history-scrollback">
              <HistoryScrollback key={selected.id} sessionId={selected.id} />
            </div>
          </>
        ) : <div className="rail-empty">Select a session.</div>}
      </div>
    </section>
  );
}
