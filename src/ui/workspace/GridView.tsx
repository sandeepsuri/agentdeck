import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types.js';
import { ElapsedTime, StatusBadge, StatusLamp, sessionLabel } from './model.js';

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function TerminalPreview({ session }: { session: Session }) {
  const [tail, setTail] = useState('');
  useEffect(() => {
    if (session.origin !== 'managed') return setTail('External terminal preview is available in its host application.');
    let disposed = false;
    const refresh = () => fetch(`/api/sessions/${encodeURIComponent(session.id)}/terminal-tail`)
      .then((response) => response.ok ? response.json() : { data: '' })
      .then((body: { data?: string }) => { if (!disposed) setTail(body.data ?? ''); })
      .catch(() => undefined);
    refresh();
    const poll = setInterval(refresh, 1500);
    return () => { disposed = true; clearInterval(poll); };
  }, [session.id, session.origin]);

  const lines = useMemo(() => stripAnsi(tail).split('\n').filter(Boolean).slice(-7), [tail]);
  return (
    <div className="grid-terminal-preview">
      {lines.length === 0 && <span className="preview-muted">Waiting for terminal output…</span>}
      {lines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}
      {session.status === 'waiting_input' && <strong>· waiting for input</strong>}
    </div>
  );
}

export function GridView({ sessions, onOpen }: { sessions: Session[]; onOpen: (session: Session) => void }) {
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
            <TerminalPreview session={session} />
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
