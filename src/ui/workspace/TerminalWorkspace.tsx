import { useEffect, useState } from 'react';
import type { AgentMessage, Session } from '../../types.js';
import { ActivityTimeline } from './ActivityTimeline.js';
import { HistoryScrollback } from './HistoryScrollback.js';
import { SessionChat } from './SessionChat.js';
import { ConversationView } from './ConversationView.js';
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
  /** Shows the session picker when present; Work's session detail omits it (the Work list is the picker). */
  onSelect?: (session: Session) => void;
  /** Durable bus events feeding the Activity tab (redesign spec §06). */
  events?: readonly AgentMessage[];
  /** Returns to the Work list. */
  onBack?: () => void;
  /** The tab a newly selected session opens on. */
  initialView?: SessionView;
  /** A tab another surface (the inspector) asked for; each new nonce switches to it once. */
  requestedView?: { view: SessionView; nonce: number };
}

export type SessionView = 'conversation' | 'chat' | 'terminal' | 'activity';

export function TerminalWorkspace({ session, sessions, ws, wsReady, onError, onFocusExternal, onSelect, events = [], onBack, initialView = 'conversation', requestedView }: Props) {
  const [view, setView] = useState<SessionView>(initialView);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  useEffect(() => { setView(initialView); }, [session?.id, initialView]);
  useEffect(() => { if (requestedView) setView(requestedView.view); }, [requestedView]);

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
      {onBack && (
        <header className="work-detail-header">
          <button className="repository-page-back" onClick={onBack} type="button">‹ Work</button>
          <h1 title={sessionLabel(session)}>{sessionLabel(session)}</h1>
          <span>{session.agent === 'claude' ? 'Claude' : 'Codex'}{session.branch ? ` · ${session.branch}` : ''}</span>
        </header>
      )}
      <div className="session-view-tabs" role="group" aria-label="Session view">
        {onSelect && (
          <label className="session-picker">
            <span>Session</span>
            <select aria-label="Selected Session" onChange={(event) => {
              const next = sessions.find((item) => item.id === event.target.value);
              if (next) onSelect(next);
            }} value={session.id}>
              {sessions.map((item) => <option key={item.id} value={item.id}>{sessionLabel(item)}</option>)}
            </select>
          </label>
        )}
        <button className="button" aria-pressed={view === 'conversation'} onClick={() => setView('conversation')} type="button">Conversation</button>
        <button className="button" aria-pressed={view === 'chat'} onClick={() => setView('chat')} type="button">Team chat</button>
        <button className="button" aria-pressed={view === 'activity'} onClick={() => setView('activity')} type="button">Activity</button>
        <button className="button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')} type="button">Terminal</button>
      </div>
      <div className="session-conversation-panel" hidden={view !== 'conversation'}>
        <ConversationView key={`${session.id}:${session.startedAt}`} onOpenTerminal={() => setView('terminal')} session={session} />
      </div>
      {view === 'chat' && <SessionChat key={session.id} session={session} onError={onError} />}
      {view === 'activity' && <div className="session-activity-panel"><ActivityTimeline events={events} session={session} /></div>}
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
                  {ws && <Terminal active={view === 'terminal' && id === session.id} key={terminalKeys[id]} sessionId={id} ws={ws} />}
                </div>
              ))}
            </div>
            {session.origin === 'managed' && session.status === 'exited' ? (
              view === 'terminal' && <div className="history-scrollback"><HistoryScrollback sessionId={session.id} /></div>
            ) : session.origin === 'managed' ? (
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
