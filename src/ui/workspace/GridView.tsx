import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types.js';
import type { ServerFrame } from '../../protocol.js';
import { ElapsedTime, StatusBadge, StatusLamp, sessionLabel } from './model.js';

// Cap the client-side accumulated tail so a long-lived session's incremental
// tile_preview chunks don't grow this string forever.
const PREVIEW_TAIL_CAP = 8000;

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function TerminalPreview({ session, tail }: { session: Session; tail: string }) {
  const lines = useMemo(() => stripAnsi(tail).split('\n').filter(Boolean).slice(-7), [tail]);

  if (session.origin !== 'managed') {
    return (
      <div className="grid-terminal-preview">
        <span className="preview-muted">External terminal preview is available in its host application.</span>
      </div>
    );
  }

  return (
    <div className="grid-terminal-preview">
      {lines.length === 0 && <span className="preview-muted">Waiting for terminal output…</span>}
      {lines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}
      {session.status === 'waiting_input' && <strong>· waiting for input</strong>}
    </div>
  );
}

// Mission Control tiles no longer poll a per-tile REST endpoint (T8): a
// single WebSocket listener here accumulates `tile_preview` frames pushed by
// the server for every managed session, keyed by session id. `seed` frames
// (sent once per connection) replace the local tail; incremental frames
// append and are capped so the string can't grow unbounded.
export function GridView({ sessions, onOpen, ws }: { sessions: Session[]; onOpen: (session: Session) => void; ws: WebSocket | null }) {
  const [previews, setPreviews] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!ws) return;
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      if (frame.t !== 'tile_preview') return;
      setPreviews((current) => {
        const previous = frame.seed ? '' : current[frame.sessionId] ?? '';
        const next = (previous + frame.data).slice(-PREVIEW_TAIL_CAP);
        return { ...current, [frame.sessionId]: next };
      });
    };
    ws.addEventListener('message', onMessage);
    return () => ws.removeEventListener('message', onMessage);
  }, [ws]);

  return (
    <section className="workspace-scroll grid-view">
      <div className="view-heading">
        <h1>Mission control</h1>
        <span>Live terminal tiles across every session</span>
      </div>
      <div className="terminal-grid">
        {sessions.map((session) => (
          <button className="terminal-tile" key={session.id} onClick={() => onOpen(session)} type="button">
            <header>
              <StatusLamp pulse={session.status === 'working' || session.status === 'waiting_input'} status={session.status} />
              <strong>{sessionLabel(session)}</strong>
              <StatusBadge status={session.status} />
            </header>
            <div className="tile-chrome">
              <span><i /><i /><i /></span>
              <em>zsh — {session.agent}-worker · pid {session.pid ?? '—'}</em>
            </div>
            <TerminalPreview session={session} tail={previews[session.id] ?? ''} />
            <footer>
              <span className="agent-tag">{session.agent === 'claude' ? 'Claude' : 'Codex'}</span>
              <span>{session.cwd.split('/').pop() ?? session.cwd}{session.branch ? ` / ${session.branch}` : ''}</span>
              <span><ElapsedTime startedAt={session.startedAt} /></span>
            </footer>
          </button>
        ))}
      </div>
      {sessions.length === 0 && <div className="empty-workspace"><strong>No terminal tiles yet</strong><span>Launch or discover a session to populate Mission control.</span></div>}
    </section>
  );
}
