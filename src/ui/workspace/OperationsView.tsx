import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentMessage, Conflict, Repo, Session } from '../../types.js';
import { ElapsedTime, SparkBars, StatusBadge, StatusLamp, relativeTime, repoPathOf, sessionLabel } from './model.js';

interface DiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

interface Props {
  sessions: Session[];
  repos: Repo[];
  selected: Session | null;
  events: AgentMessage[];
  conflicts: Conflict[];
  onSelect: (session: Session) => void;
  onOpenTerminal: (session: Session) => void;
}

function useRepoChanges(repoPath: string | undefined) {
  const [files, setFiles] = useState<DiffFileSummary[]>([]);
  useEffect(() => {
    if (!repoPath) return setFiles([]);
    let disposed = false;
    const refresh = () => {
      const query = new URLSearchParams({ repo: repoPath, mode: 'uncommitted' });
      fetch(`/api/repos/diff?${query}`)
        .then((response) => response.ok ? response.json() : { files: [] })
        .then((body: { files?: DiffFileSummary[] }) => { if (!disposed) setFiles(body.files ?? []); })
        .catch(() => { if (!disposed) setFiles([]); });
    };
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => { disposed = true; clearInterval(poll); };
  }, [repoPath]);
  return files;
}

function Trace({ session, events }: { session: Session; events: AgentMessage[] }) {
  const trace = events
    .filter((event) => event.repo === repoPathOf(session) || event.sessionId === session.id)
    .slice(-5)
    .reverse();
  return (
    <div className="operation-trace">
      <div className="micro-heading">Live trace</div>
      {trace.length === 0 && <div className="trace-empty">Waiting for agent signals…</div>}
      {trace.map((event, index) => (
        <div className="trace-line" key={`${event.ts}-${event.agent}-${event.event}-${index}`}>
          <span>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <b>{event.event}</b>
          <span>{event.message ?? event.summary ?? event.files?.join(', ') ?? event.status ?? 'Event received'}</span>
        </div>
      ))}
    </div>
  );
}

function ExpandedOperation({ session, events, onOpenTerminal }: {
  session: Session;
  events: AgentMessage[];
  onOpenTerminal: () => void;
}) {
  const changes = useRepoChanges(repoPathOf(session));
  const additions = changes.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changes.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <article className="operation-card is-expanded">
      <header className="operation-card-header">
        <StatusLamp pulse={session.status === 'waiting_input' || session.status === 'working'} status={session.status} />
        <strong>{sessionLabel(session)}</strong>
        {session.status === 'waiting_input' && <span className="input-required-tag">Input required</span>}
        <span className="operation-meta">{session.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} · PID {session.pid ?? '—'} · {session.tty ?? 'PTY'}</span>
        <StatusBadge status={session.status} />
      </header>
      <div className="operation-card-grid">
        <Trace events={events} session={session} />
        <div className="operation-tree">
          <div className="micro-heading">Working tree · {changes.length} files</div>
          {changes.length === 0 && <div className="trace-empty">Working tree clean</div>}
          {changes.slice(0, 4).map((file) => (
            <div className="tree-file" key={file.path}>
              <span title={file.path}>{file.path}</span>
              <small><em>+{file.additions}</em> <i>−{file.deletions}</i></small>
            </div>
          ))}
        </div>
        <div className="operation-gauges">
          <Metric label="Activity" value={relativeTime(session.lastActivityAt)} seed={4} />
          <Metric label="Elapsed" value={<ElapsedTime startedAt={session.startedAt} />} seed={6} />
          <Metric label="Files" value={`+${additions} −${deletions}`} seed={8} />
        </div>
      </div>
      {session.status === 'waiting_input' && (
        <div className="attention-banner">
          <span className="attention-icon">△</span>
          <span><small>Input required</small><strong>The agent is waiting for your response</strong></span>
          <button className="button attention-button" onClick={onOpenTerminal} type="button">Open prompt ↗</button>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value, seed }: { label: string; value: ReactNode; seed: number }) {
  return (
    <div className="metric">
      <span><small>{label}</small><b>{value}</b></span>
      <SparkBars count={18} seed={seed} />
    </div>
  );
}

export function OperationsView({ sessions, repos, selected, events, conflicts, onSelect, onOpenTerminal }: Props) {
  const groups = useMemo(() => {
    const byRepo = new Map<string, Session[]>();
    for (const session of sessions) {
      const key = repoPathOf(session);
      byRepo.set(key, [...(byRepo.get(key) ?? []), session]);
    }
    return [...byRepo.entries()].map(([path, groupedSessions]) => ({
      path,
      repo: repos.find((item) => item.id === path || item.path === path),
      sessions: groupedSessions,
    }));
  }, [repos, sessions]);

  return (
    <section className="workspace-scroll operations-view">
      <div className="view-heading">
        <h1>Operations</h1>
        <span>{sessions.filter((session) => !['completed', 'exited'].includes(session.status)).length} active processes across {groups.length} repositories</span>
      </div>
      {groups.map((group) => {
        const repoConflicts = conflicts.filter((conflict) => conflict.repoId === group.path);
        return (
          <section className="operation-group" key={group.path}>
            <header className="operation-group-header">
              <strong>{group.repo?.name ?? group.path.split('/').pop() ?? group.path}</strong>
              <span>⎇ {group.sessions[0]?.branch ?? group.repo?.currentBranch ?? 'unknown'}</span>
              {repoConflicts.length > 0 && <em>△ {repoConflicts.length} conflict{repoConflicts.length === 1 ? '' : 's'}</em>}
              <small>{group.sessions.length} session{group.sessions.length === 1 ? '' : 's'}</small>
            </header>
            {group.sessions.map((session) => session.id === selected?.id ? (
              <ExpandedOperation events={events} key={session.id} onOpenTerminal={() => onOpenTerminal(session)} session={session} />
            ) : (
              <button className="operation-row" key={session.id} onClick={() => onSelect(session)} type="button">
                <StatusLamp pulse={session.status === 'working'} status={session.status} />
                <strong>{sessionLabel(session)}</strong>
                <span>{session.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} · PID {session.pid ?? '—'} · {session.tty ?? 'external'}</span>
                <small><ElapsedTime startedAt={session.startedAt} /></small>
                <StatusBadge status={session.status} />
              </button>
            ))}
          </section>
        );
      })}
      {groups.length === 0 && <div className="empty-workspace"><strong>No sessions are running</strong><span>Launch an agent or rescan your terminals to populate Operations.</span></div>}
    </section>
  );
}
