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
import { useState } from 'react';
import type { Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { formatRunLabel, isTerminalRunStatus, orderRuns } from './runModel.js';
import { ElapsedTime, StatusBadge, StatusLamp, relativeTime, repoPathOf, sessionLabel } from './model.js';

export interface Props {
  repos: Repo[];
  runs: WorkRun[];
  sessions: Session[];
  selectedRunId?: string | null;
  selectedId?: string | null;
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
  return (
    <section aria-label={`${repo.name} repository`} className="workspace-scroll repository-page">
      <button className="repository-page-back" onClick={onBack} type="button">‹ Overview</button>
      <div className="view-heading">
        <h1>{repo.name}</h1>
        <span>⎇ {repo.currentBranch ?? 'unknown'} · {runs.length} run{runs.length === 1 ? '' : 's'} · {sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
      </div>

      <section className="operation-group">
        <header className="operation-group-header"><strong>Runs</strong><small>{orderedRuns.length}</small></header>
        {orderedRuns.map((run) => (
          <RunRow key={run.id} onSelect={() => onSelectRun(run)} run={run} selected={run.id === selectedRunId} />
        ))}
        {orderedRuns.length === 0 && <div className="overview-empty-row">No Runs have been requested in {repo.name} yet.</div>}
      </section>

      <section className="operation-group">
        <header className="operation-group-header"><strong>Sessions</strong><small>{orderedSessions.length}</small></header>
        {orderedSessions.map((session) => (
          <SessionRow key={session.id} onSelect={() => onSelectSession(session)} selected={session.id === selectedId} session={session} />
        ))}
        {orderedSessions.length === 0 && <div className="overview-empty-row">No agents are running in {repo.name}.</div>}
      </section>
    </section>
  );
}

export function OverviewView({ repos, runs, sessions, selectedRunId = null, selectedId = null, onSelectRun, onSelectSession }: Props) {
  // Opens on the Repository behind whatever is already selected (a run/session
  // reached via deep link, the sidebar, or the command palette) rather than
  // an arbitrary first entry — but only as a starting point: once a person
  // picks a different Repository here, or backs out to the list, that choice
  // is what persists (this component stays mounted across tab switches, so
  // no effect re-derives it from `selected*` again after the initial render).
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => {
    const selectedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) : undefined;
    if (selectedRun) return selectedRun.spec.repository.id;
    const selectedSession = selectedId ? sessions.find((session) => session.id === selectedId) : undefined;
    return selectedSession ? repoPathOf(selectedSession) : null;
  });

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
