// MobileWorkspace: the phone-facing view (ticket 13, Stage 4 "Mobile").
// Rendered by App.tsx instead of the desktop workspace tree when
// GET /api/connection reports kind === 'remote'. Deliberately not a reuse
// of Terminal.tsx/TerminalWorkspace.tsx — this is reflowed text sized to
// the viewport, not an xterm grid — but the WS attach/detach lifecycle is
// the same shape (see docs/specs/session-persistence-and-remote-access.md,
// Stage 4 step 3, and src/sessions/live-reflow.ts for the server side).
import { useEffect, useState } from 'react';
import type { Session } from '../../types.js';
import type { ClientFrame, ServerFrame } from '../../protocol.js';
import { apiFetch } from '../apiFetch.js';
import { ControlKeys } from '../components/ControlKeys.js';
import { isEndedSession, sessionLabel } from './model.js';

interface Props {
  session: Session | null;
  sessions: Session[];
  ws: WebSocket | null;
  wsReady: boolean;
  onSelect: (session: Session) => void;
  onError: (message: string) => void;
}

/**
 * Pure reducer for an incoming server frame: does it update the reflowed
 * text currently shown for `sessionId`? A 'reflow_text' frame is a full
 * replace of the view (see protocol.ts), not an incremental chunk, so this
 * never needs the previous text to compute the next one. Exported so the
 * frame-handling logic is testable without a live WebSocket or DOM.
 */
export function nextReflowText(current: string, frame: ServerFrame, sessionId: string): string {
  return frame.t === 'reflow_text' && frame.sessionId === sessionId ? frame.text : current;
}

/**
 * Same POST /api/sessions/:id/send composer pattern
 * TerminalWorkspace.tsx's sendToSession uses — routed through apiFetch
 * (not bare fetch) since a remote connection must carry the tailnet token
 * header. This is what ticket 14's "free-text messages continue to work
 * from a phone" acceptance line exercises.
 */
export async function sendToMobileSession(session: Session, text: string): Promise<{ delivered?: string; error?: string }> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json() as { delivered?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Unable to send to this session.');
  return body;
}

/**
 * Presentational only — pulled out of MobileWorkspace so the "does a
 * reflow_text frame end up on screen, reflowed rather than a fixed grid"
 * behavior can be exercised as `renderToStaticMarkup(createElement(
 * ReflowPane, { text: nextReflowText(...) }))` without a live WebSocket or
 * DOM (see MobileWorkspace.test.ts and TerminalWorkspace.test.ts for the
 * same static-render testing pattern used elsewhere in this codebase).
 * `white-space: pre-wrap; word-break: break-word` (mobile-workspace rules
 * in workspace.css) is what does the actual screen-width reflow; a `<pre>`
 * preserves the server's line breaks while still letting long lines wrap.
 */
export function ReflowPane({ text }: { text: string }) {
  return <pre className="mobile-reflow" data-testid="mobile-reflow-text">{text || 'Waiting for output…'}</pre>;
}

function SessionPicker({ sessions, value, onSelect }: { sessions: Session[]; value: string; onSelect: (session: Session) => void }) {
  return (
    <select
      aria-label="Switch session"
      className="mobile-session-picker"
      onChange={(event) => {
        const picked = sessions.find((item) => item.id === event.target.value);
        if (picked) onSelect(picked);
      }}
      value={value}
    >
      <option disabled value="">Choose a session…</option>
      {sessions.map((item) => <option key={item.id} value={item.id}>{sessionLabel(item)}</option>)}
    </select>
  );
}

export function MobileWorkspace({ session, sessions, ws, wsReady, onSelect, onError }: Props) {
  // Remote access deliberately covers managed PTYs only. The server filters
  // the list and update stream, while this last-mile filter prevents a stale
  // pre-classification desktop selection from exposing an external session.
  const managedSessions = sessions.filter((item) => item.origin === 'managed');
  const managedSession = session?.origin === 'managed' ? session : null;
  const sessionId = managedSession?.id ?? null;
  const [reflowText, setReflowText] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => { setReflowText(''); setText(''); }, [sessionId]);

  // Attach/detach lifecycle over the shared WS — same shape as
  // Terminal.tsx: attach on mount/session-change, detach on unmount,
  // listen for frames scoped to this session id.
  useEffect(() => {
    if (!ws || !sessionId) return;
    const send = (frame: ClientFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      setReflowText((current) => nextReflowText(current, frame, sessionId));
    };
    ws.addEventListener('message', onMessage);
    const attach = () => send({ t: 'attach', sessionId });
    if (ws.readyState === WebSocket.OPEN) attach();
    else ws.addEventListener('open', attach, { once: true });

    return () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', attach);
      send({ t: 'detach', sessionId });
    };
  }, [ws, sessionId]);

  const submit = async (value = text) => {
    if (!managedSession || !value.trim() || sending) return;
    setSending(true);
    try {
      await sendToMobileSession(managedSession, value.trim());
      setText('');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (!managedSession) {
    return (
      <section className="mobile-workspace mobile-workspace-empty">
        <strong>Select a session</strong>
        {managedSessions.length > 0
          ? <SessionPicker onSelect={onSelect} sessions={managedSessions} value="" />
          : <span>No sessions yet.</span>}
      </section>
    );
  }

  const canMessage = !isEndedSession(managedSession) && wsReady;

  return (
    <section className="mobile-workspace">
      <header className="mobile-topbar">
        <SessionPicker onSelect={onSelect} sessions={managedSessions} value={managedSession.id} />
      </header>

      <ReflowPane text={reflowText} />

      {/* Fixed Ctrl-C / Esc / arrow / Enter buttons (ticket 14). Gated the
          same way as the composer below — a raw write only makes sense
          while the session is live and the socket is up; the server would
          silently drop it anyway (manager.isLive check in ws.ts), but
          there's no reason to show live buttons for a dead session. */}
      {canMessage && managedSession.status === 'waiting_input' && (
        <div className="mobile-approval-actions" role="group" aria-label="Approval response">
          <button className="button prompt-primary" onClick={() => void submit('1')} type="button">[1] Yes</button>
          <button className="button" onClick={() => void submit('2')} type="button">[2] No</button>
        </div>
      )}

      {canMessage && (
        <div className="mobile-control-keys">
          <ControlKeys sessionId={managedSession.id} ws={ws} />
        </div>
      )}

      {canMessage && (
        <footer className="mobile-composer">
          <textarea
            aria-label="Message the agent"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Message the agent…"
            value={text}
          />
          <button disabled={!text.trim() || sending} onClick={() => void submit()} type="button">
            {sending ? 'Sending…' : 'Send'}
          </button>
        </footer>
      )}
    </section>
  );
}
