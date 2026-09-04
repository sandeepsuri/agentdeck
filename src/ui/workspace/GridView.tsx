import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../types.js';
import type { ServerFrame } from '../../protocol.js';
import { ElapsedTime, StatusBadge, StatusLamp, sessionLabel } from './model.js';

// Cap the client-side accumulated tail so a long-lived session's incremental
// tile_preview chunks don't grow this string forever. Chunks are kept whole
// and trimmed from the front (same discipline as the server's RingBuffer,
// src/sessions/ringbuffer.ts) rather than sliced by character count: an
// arbitrary character-offset slice can land mid ANSI escape sequence,
// stripping its leading ESC byte and leaving the rest (e.g. "38;2;153;...m")
// visible as literal text that stripAnsi's regex can no longer recognize.
const PREVIEW_TAIL_CAP = 8000;

function appendPreviewChunk(chunks: string[], data: string): string[] {
  const next = [...chunks, data];
  let total = next.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > PREVIEW_TAIL_CAP && next.length > 1) {
    total -= next[0]!.length;
    next.shift();
  }
  return next;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function TerminalPreview({ session, tail }: { session: Session; tail: string }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => stripAnsi(tail).split('\n').filter(Boolean).slice(-7), [tail]);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview) preview.scrollTop = preview.scrollHeight;
  }, [tail]);

  if (session.origin !== 'managed') {
    return (
      <div aria-label="Activity log" className="grid-terminal-preview" role="log">
        <span className="preview-muted">External terminal preview is available in its host application.</span>
      </div>
    );
  }

  return (
    <div aria-label="Activity log" aria-live="polite" className="grid-terminal-preview" ref={previewRef} role="log">
      {lines.length === 0 && <span className="preview-muted">Waiting for terminal output…</span>}
      {lines.map((line, index) => <span className="preview-entry" key={`${line}-${index}`}>{line}</span>)}
      {session.status === 'waiting_input' && <strong className="preview-attention">Waiting for input</strong>}
    </div>
  );
}

// Mission Control tiles no longer poll a per-tile REST endpoint (T8): a
// single WebSocket listener here accumulates `tile_preview` frames pushed by
// the server for every managed session, keyed by session id. `seed` frames
// (sent once per connection) replace the local tail; incremental frames
// append and are capped so the string can't grow unbounded.
export function GridView({ sessions, onOpen, ws }: { sessions: Session[]; onOpen: (session: Session) => void; ws: WebSocket | null }) {
  const [previews, setPreviews] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!ws) return;
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      if (frame.t !== 'tile_preview') return;
      setPreviews((current) => {
        const chunks = frame.seed ? [] : current[frame.sessionId] ?? [];
        return { ...current, [frame.sessionId]: appendPreviewChunk(chunks, frame.data) };
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
            <div className="tile-activity-header">
              <span className={session.status === 'starting' || session.status === 'working' || session.status === 'waiting_input' ? 'tile-live-dot is-active' : 'tile-live-dot'} />
              <strong>Live activity</strong>
            </div>
            <TerminalPreview session={session} tail={(previews[session.id] ?? []).join('')} />
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
