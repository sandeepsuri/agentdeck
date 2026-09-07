// Ticket 47 (B01): a read-only, cross-Repository landing for the admin
// desktop workspace, plus a dedicated per-Repository page. Composes only
// Repository/Run/Session data App.tsx already fetches through the existing
// authorized reads (GET /api/repos, /api/runs, /api/sessions) — no new
// endpoint, projection, or capability. Selecting a Run or Session hands off
// to the same selectRun/selectSession handlers every other entry point uses
// (SessionSidebar, CommandPalette), so the detail that opens is the one
// Run/Session workspace that already exists — never a new one.
//
// This mirrors CollaboratorWorkspace's Repository-first navigation (ticket
// 44) on the admin side: a Repository is the level above its Runs and
// Sessions, and there is nothing above a Repository to navigate to.
// `activeRepoId` is looked up against the live `repos` list on every render
// rather than trusted blindly, so a Repository that disappears (discovery
// change, revoked path) falls back to the overview list instead of showing
// stale content for a Repository that is no longer there.
import { useEffect, useState } from 'react';
import type { Repo, Session, SessionStatus } from '../../types.js';
import type { RunStatus, WorkRun } from '../../work-engine/types.js';
import { formatRunLabel, isTerminalRunStatus, orderRuns, RUN_STATUS_OPTIONS } from './runModel.js';
import { ElapsedTime, SESSION_STATUS_OPTIONS, STATUS_LABELS, StatusBadge, StatusLamp, relativeTime, repoPathOf, sessionLabel } from './model.js';

export interface Props {
  repos: Repo[];
  runs: WorkRun[];
  sessions: Session[];
  selectedRunId?: string | null;
  selectedId?: string | null;
  /** A stable Repository destination chosen outside this view, such as global search. */
  requestedRepositoryId?: string | null;
  /** Changes for each navigation request so selecting the same Repository again still reopens it after Back. */
  requestedNavigationSequence?: number;
  onSelectRun: (run: WorkRun) => void;
  onSelectSession: (session: Session) => void;
}

function repoOf(repos: readonly Repo[], id: string | undefined): Repo | undefined {
  return repos.find((repo) => repo.id === id || repo.path === id);
}

function runsForRepo(runs: readonly WorkRun[], repoId: string): WorkRun[] {
  return runs.filter((run) => run.spec.repository.id === repoId);
}

function sessionsForRepo(sessions: readonly Session[], repo: Repo): Session[] {
  return sessions.filter((session) => repoPathOf(session) === repo.id || repoPathOf(session) === repo.path);
}

function orderSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const bandOf = (session: Session) => session.status === 'waiting_input' ? 0 : ['completed', 'exited'].includes(session.status) ? 2 : 1;
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

function RepoCard({ repo, runs, sessions, onOpen }: {
  repo: Repo;
  runs: readonly WorkRun[];
  sessions: readonly Session[];
  onOpen: () => void;
}) {
  const activeRuns = runs.filter((run) => !isTerminalRunStatus(run.status)).length;
  const activeSessions = sessions.filter((session) => !['completed', 'exited'].includes(session.status)).length;
  const needsAttention = runs.filter((run) => Boolean(run.pendingAttention)).length
    + sessions.filter((session) => session.status === 'waiting_input').length;
  return (
    <button className="repo-overview-card" data-repo-id={repo.id} onClick={onOpen} type="button">
      <span className="repo-overview-card-head">
        <strong>{repo.name}</strong>
        <span>⎇ {repo.currentBranch ?? 'unknown'}</span>
      </span>
      <span className="repo-overview-card-counts">
        <span>{runs.length} run{runs.length === 1 ? '' : 's'}</span>
        <span>{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
        {activeRuns + activeSessions > 0 && <span className="is-active-count">{activeRuns + activeSessions} active</span>}
        {needsAttention > 0 && <em className="repo-overview-attention">△ {needsAttention} need{needsAttention === 1 ? 's' : ''} attention</em>}
      </span>
    </button>
  );
}

function RunRow({ run, selected, onSelect }: { run: WorkRun; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`overview-row overview-run-row${selected ? ' is-selected' : ''}`} data-run-id={run.id} onClick={onSelect} type="button">
      <span className="overview-row-glyph overview-run-glyph">RUN</span>
      <span className="overview-row-content">
        <strong title={run.spec.objective}>{run.spec.objective}</strong>
        <small>{run.principal.displayName} · {relativeTime(run.submittedAt)}</small>
      </span>
      {run.pendingAttention && <span className="overview-row-attention">Needs attention</span>}
      <span className={`work-run-status status-${run.status}`}>{formatRunLabel(run.status)}</span>
    </button>
  );
}

function SessionRow({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`overview-row overview-session-row${selected ? ' is-selected' : ''}`} data-session-id={session.id} onClick={onSelect} type="button">
      <StatusLamp pulse={session.status === 'working'} status={session.status} />
      <span className="overview-row-content">
        <strong>{sessionLabel(session)}</strong>
        <small>{session.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} · <ElapsedTime startedAt={session.startedAt} /></small>
      </span>
      <StatusBadge status={session.status} />
    </button>
  );
}

function RepositoryPage({ repo, runs, sessions, selectedRunId, selectedId, onSelectRun, onSelectSession, onBack }: {
  repo: Repo;
  runs: readonly WorkRun[];
  sessions: readonly Session[];
  selectedRunId: string | null;
  selectedId: string | null;
  onSelectRun: (run: WorkRun) => void;
  onSelectSession: (session: Session) => void;
  onBack: () => void;
}) {
  const orderedRuns = orderRuns(runs);
  const orderedSessions = orderSessions(sessions);
  const [runStatus, setRunStatus] = useState<'all' | RunStatus>('all');
  const [sessionStatus, setSessionStatus] = useState<'all' | SessionStatus>('all');
  const visibleRuns = runStatus === 'all' ? orderedRuns : orderedRuns.filter((run) => run.status === runStatus);
  const visibleSessions = sessionStatus === 'all' ? orderedSessions : orderedSessions.filter((session) => session.status === sessionStatus);
  return (
    <section aria-label={`${repo.name} repository`} className="workspace-scroll repository-page">
      <button className="repository-page-back" onClick={onBack} type="button">‹ Overview</button>
      <div className="view-heading">
        <h1>{repo.name}</h1>
        <span>⎇ {repo.currentBranch ?? 'unknown'} · {runs.length} run{runs.length === 1 ? '' : 's'} · {sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
      </div>

      <section className="operation-group">
        <header className="operation-group-header">
          <strong>Runs</strong><small>{visibleRuns.length} of {orderedRuns.length}</small>
          <select aria-label="Filter Runs by status" onChange={(event) => setRunStatus(event.target.value as 'all' | RunStatus)} value={runStatus}>
            <option value="all">All statuses</option>
            {RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{formatRunLabel(status)}</option>)}
          </select>
        </header>
        {visibleRuns.map((run) => (
          <RunRow key={run.id} onSelect={() => onSelectRun(run)} run={run} selected={run.id === selectedRunId} />
        ))}
        {orderedRuns.length === 0 && <div className="overview-empty-row">No Runs have been requested in {repo.name} yet.</div>}
        {orderedRuns.length > 0 && visibleRuns.length === 0 && <div className="overview-empty-row">No Runs match {formatRunLabel(runStatus)}.</div>}
      </section>

      <section className="operation-group">
        <header className="operation-group-header">
          <strong>Sessions</strong><small>{visibleSessions.length} of {orderedSessions.length}</small>
          <select aria-label="Filter Sessions by status" onChange={(event) => setSessionStatus(event.target.value as 'all' | SessionStatus)} value={sessionStatus}>
            <option value="all">All statuses</option>
            {SESSION_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
          </select>
        </header>
        {visibleSessions.map((session) => (
          <SessionRow key={session.id} onSelect={() => onSelectSession(session)} selected={session.id === selectedId} session={session} />
        ))}
        {orderedSessions.length === 0 && <div className="overview-empty-row">No agents are running in {repo.name}.</div>}
        {orderedSessions.length > 0 && visibleSessions.length === 0 && <div className="overview-empty-row">No Sessions match {sessionStatus === 'all' ? 'all statuses' : STATUS_LABELS[sessionStatus]}.</div>}
      </section>
    </section>
  );
}

export function OverviewView({ repos, runs, sessions, selectedRunId = null, selectedId = null, requestedRepositoryId = null, requestedNavigationSequence = 0, onSelectRun, onSelectSession }: Props) {
  // Opens on the Repository behind whatever is already selected (a run/session
  // reached via deep link, the sidebar, or the command palette) rather than
  // an arbitrary first entry — but only as a starting point: once a person
  // picks a different Repository here, or backs out to the list, that choice
  // is what persists (this component stays mounted across tab switches, so
  // no effect re-derives it from `selected*` again after the initial render).
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => {
    if (requestedRepositoryId && repoOf(repos, requestedRepositoryId)) return requestedRepositoryId;
    const selectedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) : undefined;
    if (selectedRun) return selectedRun.spec.repository.id;
    const selectedSession = selectedId ? sessions.find((session) => session.id === selectedId) : undefined;
    return selectedSession ? repoPathOf(selectedSession) : null;
  });

  useEffect(() => {
    if (requestedRepositoryId) setActiveRepoId(requestedRepositoryId);
  }, [requestedRepositoryId, requestedNavigationSequence]);

  // Re-resolved every render (never trusted from state directly) so a
  // Repository that stops being discoverable — an unwatched path, a revoked
  // scope — falls back to the list instead of rendering stale content.
  const activeRepo = activeRepoId ? repoOf(repos, activeRepoId) : undefined;

  if (activeRepo) {
    return (
      <RepositoryPage
        onBack={() => setActiveRepoId(null)}
        onSelectRun={onSelectRun}
        onSelectSession={onSelectSession}
        repo={activeRepo}
        runs={runsForRepo(runs, activeRepo.id)}
        selectedId={selectedId}
        selectedRunId={selectedRunId}
        sessions={sessionsForRepo(sessions, activeRepo)}
      />
    );
  }

  return (
    <section className="workspace-scroll overview-view">
      <div className="view-heading">
        <h1>Overview</h1>
        <span>{repos.length} repositor{repos.length === 1 ? 'y' : 'ies'} · {runs.length} runs · {sessions.length} sessions</span>
      </div>
      <div className="repo-overview-grid">
        {repos.map((repo) => (
          <RepoCard
            key={repo.id}
            onOpen={() => setActiveRepoId(repo.id)}
            repo={repo}
            runs={runsForRepo(runs, repo.id)}
            sessions={sessionsForRepo(sessions, repo)}
          />
        ))}
      </div>
      {repos.length === 0 && <div className="empty-workspace"><strong>No repositories found</strong><span>Discover a local Git repository to see its work here.</span></div>}
    </section>
  );
}
