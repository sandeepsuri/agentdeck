import { useEffect, useState } from 'react';
import type { Session } from '../../types.js';
import { apiFetch } from '../apiFetch.js';
import { Terminal } from '../components/Terminal.js';
import { ElapsedTime, isEndedSession, sessionLabel } from './model.js';
import { nextMountedTerminalIds, sameIds, terminalViewKeys } from './terminalViews.js';

interface Props {
  session: Session | null;
  sessions: Session[];
  ws: WebSocket | null;
  wsReady: boolean;
  onError: (message: string) => void;
  onFocusExternal: (session: Session) => void;
}

async function sendToSession(session: Session, text: string): Promise<{ delivered?: string; error?: string }> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json() as { delivered?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Unable to send to this session.');
  return body;
}

export function TerminalWorkspace({ session, sessions, ws, wsReady, onError, onFocusExternal }: Props) {
  const [text, setText] = useState('');
  const [queue, setQueue] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  useEffect(() => { setText(''); setQueue([]); }, [session?.id]);

  const selectableId = session && session.origin === 'managed' && wsReady && ws ? session.id : null;
  useEffect(() => {
    setMountedIds((current) => {
      const next = nextMountedTerminalIds(current, sessions, selectableId);
      return sameIds(current, next) ? current : next;
    });
  }, [sessions, selectableId]);
  const terminalKeys = terminalViewKeys(mountedIds, sessions);

  const send = async (value = text) => {
    if (!session || !value.trim() || sending) return;
    setSending(true);
    try {
      await sendToSession(session, value.trim());
      setText('');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (!session) {
    return <div className="empty-workspace"><strong>Select a session</strong><span>The active terminal and agent controls will appear here.</span></div>;
  }
  const canMessage = !isEndedSession(session);

  return (
    <section className="terminal-workspace">
      <div className="terminal-frame">
        <header className="terminal-chrome">
          <span className="traffic-lights"><i /><i /><i /></span>
          <strong>zsh — {sessionLabel(session).toLowerCase().replaceAll(' ', '-')}</strong>
          <span>{session.origin === 'managed' ? 'PTY' : session.terminalApp ?? 'External'} · {session.pid ?? '—'} · <em><ElapsedTime startedAt={session.startedAt} /></em></span>
        </header>

        <div className="terminal-body">
          <div className="terminal-view-stack">
            {mountedIds.map((id) => (
              <div className={id === session.id ? 'terminal-view is-active' : 'terminal-view'} key={id}>
                {ws && <Terminal key={terminalKeys[id]} sessionId={id} ws={ws} />}
              </div>
            ))}
          </div>
          {session.origin === 'managed' ? (
            !mountedIds.includes(session.id) && <div className="terminal-loading">Terminal reconnecting…</div>
          ) : (
            <div className="external-terminal-overview">
              <span className="external-terminal-glyph">&gt;_</span>
              <strong>{session.terminalApp ?? 'External terminal'} session</strong>
              <span>{session.cwd}</span>
              <button className="button" disabled={!session.terminalRef} onClick={() => onFocusExternal(session)} type="button">Focus external terminal ↗</button>
            </div>
          )}
        </div>

        {canMessage && session.status === 'waiting_input' && (
          <div className="terminal-prompt-card">
            <small>User input required</small>
            <strong>The agent is waiting for a response</strong>
            <span>{session.cwd}</span>
            <div>
              <button className="button prompt-primary" onClick={() => void send('1')} type="button">[1] Yes, continue</button>
              <button className="button" onClick={() => void send('2')} type="button">[2] No, exit</button>
              <em>choose an option or type a response below</em>
            </div>
          </div>
        )}

        {canMessage && queue.length > 0 && (
          <div className="message-queue">
            <div className="micro-heading">Queue · {queue.length}</div>
            {queue.map((item, index) => (
              <div className="queue-item" key={`${item}-${index}`}>
                <span>⠿</span><strong>{item}</strong><small>next turn</small>
                <button aria-label="Remove queued instruction" onClick={() => setQueue((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button">×</button>
              </div>
            ))}
          </div>
        )}

        {canMessage && <footer className="terminal-composer">
          <label>
            <span>Send to {session.origin === 'managed' ? 'PTY' : 'session'}</span>
            <input
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Type a response, or queue the next instruction…"
              value={text}
            />
          </label>
          <button className="button" disabled={!text.trim()} onClick={() => {
            if (text.trim()) setQueue((current) => [...current, text.trim()]);
            setText('');
          }} type="button">Queue</button>
          <button className="button button-primary" disabled={!text.trim() || sending} onClick={() => void send()} type="button">{sending ? 'Sending…' : 'Send ⌘⏎'}</button>
        </footer>}
      </div>
    </section>
  );
}
