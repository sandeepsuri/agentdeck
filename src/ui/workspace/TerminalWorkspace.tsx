import { useEffect, useState } from 'react';
import type { Session } from '../../types.js';
import { SessionChat } from './SessionChat.js';
import { Terminal } from '../components/Terminal.js';
import { ElapsedTime, sessionLabel } from './model.js';
import { nextMountedTerminalIds, sameIds, terminalViewKeys } from './terminalViews.js';

interface Props {
  session: Session | null;
  sessions: Session[];
  ws: WebSocket | null;
  wsReady: boolean;
  onError: (message: string) => void;
  onFocusExternal: (session: Session) => void;
}

export function TerminalWorkspace({ session, sessions, ws, wsReady, onError, onFocusExternal }: Props) {
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  useEffect(() => { setView('chat'); }, [session?.id]);

  const selectableId = view === 'terminal' && session && session.origin === 'managed' && wsReady && ws ? session.id : null;
  useEffect(() => {
    setMountedIds((current) => {
      const next = nextMountedTerminalIds(current, sessions, selectableId);
      return sameIds(current, next) ? current : next;
    });
  }, [sessions, selectableId]);
  const terminalKeys = terminalViewKeys(mountedIds, sessions);

  if (!session) {
    return <div className="empty-workspace"><strong>Select a session</strong><span>The shared conversation will appear here.</span></div>;
  }

  return (
    <section className="terminal-workspace session-workspace">
      <div className="session-view-tabs" role="group" aria-label="Session view">
        <button className="button" aria-pressed={view === 'chat'} onClick={() => setView('chat')} type="button">Chat</button>
        <button className="button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')} type="button">Terminal</button>
      </div>
      {view === 'chat' && <SessionChat key={session.id} session={session} onError={onError} />}
      <div className="session-terminal-panel" hidden={view !== 'terminal'}>
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

        </div>
      </div>
    </section>
  );
}
