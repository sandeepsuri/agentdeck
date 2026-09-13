import { useEffect, useState } from 'react';
import { apiFetch } from '../apiFetch.js';

/**
 * Fetches and renders the compacted scrollback for one ended session
 * (ticket 09's endpoint). Used by ticket 68 (B13)'s companion-Sessions
 * panel (RunWorkspace.tsx) and by an ended session's Terminal tab in Work.
 */
export function HistoryScrollback({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<{ loading: boolean; scrollback: string | null; error: string | null }>({
    loading: true, scrollback: null, error: null,
  });

  useEffect(() => {
    let disposed = false;
    setState({ loading: true, scrollback: null, error: null });
    apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/scrollback`)
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
