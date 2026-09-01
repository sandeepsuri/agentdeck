// MobileWorkspace: the phone-facing view (ticket 13, Stage 4 "Mobile").
// Rendered by App.tsx instead of the desktop workspace tree when
// GET /api/connection reports kind === 'remote'. Deliberately not a reuse
// of Terminal.tsx/TerminalWorkspace.tsx — this is reflowed text sized to
// the viewport, not an xterm grid — but the WS attach/detach lifecycle is
// the same shape (see docs/specs/session-persistence-and-remote-access.md,
// Stage 4 step 3, and src/sessions/live-reflow.ts for the server side).
import { useEffect, useState } from 'react';
import type { RunAttentionItem, Session } from '../../types.js';
import type { AttentionDecisionInput } from '../../work-engine/types.js';
import type { ClientFrame, ServerFrame } from '../../protocol.js';
import { apiFetch } from '../apiFetch.js';
import { ControlKeys } from '../components/ControlKeys.js';
import { STATUS_LABELS, isEndedSession, relativeTime, sessionLabel } from './model.js';

interface Props {
  session: Session | null;
  sessions: Session[];
  ws: WebSocket | null;
  wsReady: boolean;
  onSelect: (session: Session) => void;
  onError: (message: string) => void;
  /** Ticket 07: the minimal, remote-safe pending-attention queue (GET /api/runs/attention) — empty by default so existing callers/tests need no change. */
  runAttention?: RunAttentionItem[];
  onResolveRunAttention?: (runId: string, attentionId: string, decision: AttentionDecisionInput) => void;
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

/** Ticket 07: the input-kind Run attention response — same pulled-out-state pattern as RunWorkspace's AttentionInputForm. */
function RunAttentionInputForm({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="mobile-run-attention-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim());
        setValue('');
      }}
    >
      <input aria-label="Clarifying input" onChange={(event) => setValue(event.target.value)} type="text" value={value} />
      <button className="is-primary" disabled={!value.trim()} type="submit">Send</button>
    </form>
  );
}

function MenuIcon() {
  return <span aria-hidden="true" className="mobile-menu-icon"><i /><i /><i /></span>;
}

function AgentMark() {
  return <span aria-hidden="true" className="mobile-agent-mark"><i /></span>;
}

function SessionDrawer({ open, sessions, selectedId, onClose, onSelect }: {
  open: boolean;
  sessions: Session[];
  selectedId: string | null;
  onClose: () => void;
  onSelect: (session: Session) => void;
}) {
  return (
    <>
      <button
        aria-hidden={!open}
        aria-label="Close sessions"
        className={`mobile-drawer-scrim${open ? ' is-open' : ''}`}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        type="button"
      />
      <aside aria-hidden={!open} aria-modal={open || undefined} className={`mobile-session-drawer${open ? ' is-open' : ''}`} role="dialog">
        <header className="mobile-drawer-header">
          <span className="mobile-drawer-brand"><AgentMark /><strong>AgentDeck</strong></span>
          <button aria-label="Close sessions" className="mobile-icon-button" onClick={onClose} tabIndex={open ? 0 : -1} type="button">×</button>
        </header>

        <div className="mobile-drawer-label">Managed sessions</div>
        <nav aria-label="Managed sessions" className="mobile-session-list">
          {sessions.map((item) => (
            <button
              className={`mobile-session-row${item.id === selectedId ? ' is-selected' : ''}${isEndedSession(item) ? ' is-ended' : ''}`}
              data-session-id={item.id}
              key={item.id}
              onClick={() => { onSelect(item); onClose(); }}
              tabIndex={open ? 0 : -1}
              type="button"
            >
              <span aria-hidden="true" className="mobile-session-glyph">&gt;_</span>
              <span className="mobile-session-copy">
                <strong>{sessionLabel(item)}</strong>
                <small>{STATUS_LABELS[item.status]} · {relativeTime(item.lastActivityAt)}</small>
              </span>
              <span aria-label={STATUS_LABELS[item.status]} className={`mobile-status-dot status-${item.status}`} />
            </button>
          ))}
          {sessions.length === 0 && <p className="mobile-session-empty">No managed sessions yet.</p>}
        </nav>

        <footer className="mobile-drawer-footer">
          <span aria-hidden="true" className="mobile-lock">⌁</span>
          <span><strong>Private connection</strong><small>Tailscale protected</small></span>
        </footer>
      </aside>
    </>
  );
}

export function MobileWorkspace({
  session, sessions, ws, wsReady, onSelect, onError, runAttention = [], onResolveRunAttention,
}: Props) {
  // Remote access deliberately covers managed PTYs only. The server filters
  // the list and update stream, while this last-mile filter prevents a stale
  // pre-classification desktop selection from exposing an external session.
  const managedSessions = sessions.filter((item) => item.origin === 'managed');
  const managedSession = session?.origin === 'managed' ? session : null;
  const sessionId = managedSession?.id ?? null;
  const [reflowText, setReflowText] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [controlKeysOpen, setControlKeysOpen] = useState(false);

  useEffect(() => {
    setReflowText('');
    setText('');
    setControlKeysOpen(false);
  }, [sessionId]);

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

  const canMessage = Boolean(managedSession && !isEndedSession(managedSession) && wsReady);

  return (
    <section className="mobile-workspace">
      <header className="mobile-topbar">
        <button aria-label="Open sessions" className="mobile-icon-button" onClick={() => setDrawerOpen(true)} type="button"><MenuIcon /></button>
        <span className="mobile-topbar-copy">
          <strong>{managedSession ? sessionLabel(managedSession) : 'AgentDeck'}</strong>
          <small>
            {managedSession
              ? <><span className={`mobile-status-dot status-${managedSession.status}`} />{managedSession.agent === 'claude' ? 'Claude Code' : 'Codex'} · {STATUS_LABELS[managedSession.status].toLowerCase()}</>
              : 'Remote sessions'}
          </small>
        </span>
        <span aria-hidden="true" className="mobile-topbar-spacer" />
      </header>

      {runAttention.length > 0 && (() => {
        const pending = runAttention[0]!;
        return (
          <section aria-labelledby="mobile-run-attention-title" className="mobile-approval-card mobile-run-attention-card">
            <span aria-hidden="true" className="mobile-approval-icon">!</span>
            <span className="mobile-approval-copy">
              <strong id="mobile-run-attention-title">{pending.kind === 'approval' ? 'Run approval needed' : 'Run input needed'}</strong>
              <small>{pending.objective}</small>
              <small>{pending.reason}</small>
            </span>
            {pending.kind === 'approval' ? (
              <div aria-label="Run approval response" className="mobile-approval-actions" role="group">
                <button onClick={() => onResolveRunAttention?.(pending.runId, pending.attentionId, { kind: 'deny' })} type="button">Deny</button>
                <button
                  className="is-primary"
                  onClick={() => onResolveRunAttention?.(pending.runId, pending.attentionId, { kind: 'approve' })}
                  type="button"
                >
                  Approve
                </button>
              </div>
            ) : (
              <RunAttentionInputForm
                onSubmit={(value) => onResolveRunAttention?.(pending.runId, pending.attentionId, { kind: 'input', value })}
              />
            )}
          </section>
        );
      })()}

      {managedSession ? (
        <main className="mobile-conversation">
          <div className="mobile-conversation-date">Live session</div>
          <section aria-label="Agent output" className="mobile-agent-response">
            <AgentMark />
            <div className="mobile-agent-output">
              <div className="mobile-output-label"><span>Terminal output</span><span className={wsReady ? 'is-live' : 'is-reconnecting'}><i />{wsReady ? 'live' : 'reconnecting'}</span></div>
              <ReflowPane text={reflowText} />
            </div>
          </section>
        </main>
      ) : (
        <main className="mobile-workspace-empty">
          <AgentMark />
          <strong>Select a session</strong>
          <span>{managedSessions.length > 0 ? 'Open the menu to continue a managed session.' : 'No managed sessions yet.'}</span>
          {managedSessions.length > 0 && <button className="mobile-empty-action" onClick={() => setDrawerOpen(true)} type="button">View sessions</button>}
        </main>
      )}

      {/* Fixed Ctrl-C / Esc / arrow / Enter buttons (ticket 14). Gated the
          same way as the composer below — a raw write only makes sense
          while the session is live and the socket is up; the server would
          silently drop it anyway (manager.isLive check in ws.ts), but
          there's no reason to show live buttons for a dead session. */}
      {canMessage && managedSession?.status === 'waiting_input' && (
        <section aria-labelledby="mobile-approval-title" className="mobile-approval-card">
          <span aria-hidden="true" className="mobile-approval-icon">!</span>
          <span className="mobile-approval-copy"><strong id="mobile-approval-title">Response needed</strong><small>The agent is waiting for your input.</small></span>
          <div className="mobile-approval-actions" role="group" aria-label="Approval response">
            <button onClick={() => void submit('2')} type="button">[2] No</button>
            <button className="is-primary" onClick={() => void submit('1')} type="button">[1] Yes</button>
          </div>
        </section>
      )}

      {canMessage && managedSession && (
        <div className={`mobile-control-keys${controlKeysOpen ? ' is-open' : ''}`}>
          <ControlKeys sessionId={managedSession.id} ws={ws} />
        </div>
      )}

      {canMessage && managedSession && (
        <footer className="mobile-composer-wrap">
          <div className="mobile-composer">
            <textarea
              aria-label="Message the agent"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Message AgentDeck"
              rows={1}
              value={text}
            />
            <div className="mobile-composer-actions">
              <button
                aria-label="Toggle terminal control keys"
                aria-pressed={controlKeysOpen}
                className="mobile-keys-toggle"
                onClick={() => setControlKeysOpen((current) => !current)}
                type="button"
              ><span aria-hidden="true">&gt;_</span> Keys</button>
              <button aria-label="Send message" className="mobile-send-button" disabled={!text.trim() || sending} onClick={() => void submit()} type="button">
                {sending ? <span aria-hidden="true">…</span> : <span aria-hidden="true">↑</span>}
              </button>
            </div>
          </div>
          <small className="mobile-connection-note">Connected privately via Tailscale</small>
        </footer>
      )}

      <SessionDrawer
        onClose={() => setDrawerOpen(false)}
        onSelect={onSelect}
        open={drawerOpen}
        selectedId={sessionId}
        sessions={managedSessions}
      />
    </section>
  );
}
