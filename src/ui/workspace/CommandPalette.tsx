import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollaboratorSession, Repo, Session } from '../../types.js';
import type { CollaboratorRunSummary, WorkRun } from '../../work-engine/types.js';
import { formatRunLabel } from './runModel.js';
import { sessionLabel, type WorkspaceView, WORKSPACE_VIEWS } from './model.js';

type SearchRun = WorkRun | CollaboratorRunSummary;
type SearchSession = Session | CollaboratorSession;

export interface Props<R extends SearchRun = WorkRun, S extends SearchSession = Session> {
  open: boolean;
  sessions: S[];
  repos: Repo[];
  runs: R[];
  onClose: () => void;
  onLaunch?: () => void;
  onSelectRepo: (repo: Repo) => void;
  onSelectRun: (run: R) => void;
  onSelectSession: (session: S) => void;
  onView?: (view: WorkspaceView) => void;
}

function runObjective(run: SearchRun): string {
  return 'spec' in run ? run.spec.objective : run.objective;
}

function runRepository(run: SearchRun): { id: string; name: string } {
  return 'spec' in run ? run.spec.repository : run.repository;
}

function runRequester(run: SearchRun): string {
  return 'principal' in run ? run.principal.displayName : run.requestedBy;
}

function searchSessionLabel(session: SearchSession): string {
  if ('cwd' in session) return sessionLabel(session);
  return session.name ?? (session.agent === 'claude' ? 'Claude Code' : 'Codex');
}

export function CommandPalette<R extends SearchRun, S extends SearchSession>({ open, sessions, repos, runs, onClose, onLaunch, onSelectRepo, onSelectRun, onSelectSession, onView }: Props<R, S>) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setSelectedIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  const normalized = query.trim().toLowerCase();
  const visibleSessions = useMemo(() => sessions.filter((session) =>
    !normalized || `${searchSessionLabel(session)} ${'cwd' in session ? session.cwd : session.repoId} ${session.branch ?? ''} ${session.agent} ${session.status.replaceAll('_', ' ')}`.toLowerCase().includes(normalized)), [normalized, sessions]);
  const visibleRepos = useMemo(() => repos.filter((repo) =>
    !normalized || `${repo.name} ${repo.path} ${repo.currentBranch ?? ''}`.toLowerCase().includes(normalized)), [normalized, repos]);
  const visibleRuns = useMemo(() => runs.filter((run) =>
    !normalized || `${runObjective(run)} ${run.id} ${'taskId' in run ? run.taskId : ''} ${runRepository(run).name} ${runRequester(run)} ${formatRunLabel(run.status)}`.toLowerCase().includes(normalized)), [normalized, runs]);
  const visibleViews = onView ? WORKSPACE_VIEWS.filter((view) => !normalized || view.label.toLowerCase().includes(normalized)) : [];
  const showLaunch = Boolean(onLaunch) && (!normalized || 'launch new session'.includes(normalized));
  const items = [
    ...(showLaunch ? [{ key: 'action:launch', activate: () => { onClose(); onLaunch?.(); } }] : []),
    ...visibleViews.map((view) => ({ key: `view:${view.id}`, activate: () => { onView?.(view.id); onClose(); } })),
    ...visibleRepos.map((repo) => ({ key: `repo:${repo.id}`, activate: () => { onSelectRepo(repo); onClose(); } })),
    ...visibleRuns.map((run) => ({ key: `run:${run.id}`, activate: () => { onSelectRun(run); onClose(); } })),
    ...visibleSessions.map((session) => ({ key: `session:${session.id}`, activate: () => { onSelectSession(session); onClose(); } })),
  ];
  const currentIndex = items.length === 0 ? -1 : Math.min(selectedIndex, items.length - 1);
  const activateItem = (key: string) => items.find((item) => item.key === key)?.activate();
  const selectionProps = (key: string) => {
    const index = items.findIndex((item) => item.key === key);
    return {
      'aria-current': index === currentIndex ? 'true' as const : undefined,
      className: index === currentIndex ? 'is-selected' : undefined,
      onMouseEnter: () => setSelectedIndex(index),
    };
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex((current) => (Math.min(current, items.length - 1) + direction + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter' && currentIndex >= 0) {
      event.preventDefault();
      items[currentIndex]!.activate();
    }
  };

  if (!open) return null;
  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <section aria-label="Command palette" aria-modal="true" className="command-palette" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <div className="palette-input"><span>&gt;_</span><input ref={inputRef} onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} onKeyDown={onInputKeyDown} placeholder="Search repositories, runs, sessions, or actions…" value={query} /><kbd>ESC</kbd></div>
        <div className="palette-results">
          {(onLaunch || onView) && <div className="sidebar-section-label"><span>Actions</span></div>}
          {showLaunch && <button {...selectionProps('action:launch')} onClick={() => activateItem('action:launch')} type="button"><span>＋</span><strong>Launch new session</strong><kbd>⌘L</kbd></button>}
          {visibleViews.map((view) => <button {...selectionProps(`view:${view.id}`)} key={view.id} onClick={() => activateItem(`view:${view.id}`)} type="button"><span>⌘</span><strong>Open {view.label}</strong></button>)}
          <div className="sidebar-section-label"><span>Repositories</span><span>{visibleRepos.length}</span></div>
          {visibleRepos.map((repo) => <button {...selectionProps(`repo:${repo.id}`)} data-repo-id={repo.id} key={repo.id} onClick={() => activateItem(`repo:${repo.id}`)} type="button"><span>▣</span><strong>{repo.name}<small>{repo.path}{repo.currentBranch ? ` · ${repo.currentBranch}` : ''}</small></strong></button>)}
          <div className="sidebar-section-label"><span>Runs</span><span>{visibleRuns.length}</span></div>
          {visibleRuns.map((run) => <button {...selectionProps(`run:${run.id}`)} data-run-id={run.id} key={run.id} onClick={() => activateItem(`run:${run.id}`)} type="button"><span>RUN</span><strong>{runObjective(run)}<small>{runRepository(run).name} · {run.id}</small></strong><em>{formatRunLabel(run.status)}</em></button>)}
          <div className="sidebar-section-label"><span>Sessions</span><span>{visibleSessions.length}</span></div>
          {visibleSessions.map((session) => <button {...selectionProps(`session:${session.id}`)} data-session-id={session.id} key={session.id} onClick={() => activateItem(`session:${session.id}`)} type="button"><span>{session.agent === 'claude' ? 'C' : '⌘'}</span><strong>{searchSessionLabel(session)}<small>{'cwd' in session ? session.cwd : repos.find((repo) => repo.id === session.repoId)?.name ?? session.repoId}{session.branch ? ` · ${session.branch}` : ''}</small></strong><em>{session.status.replaceAll('_', ' ')}</em></button>)}
          {items.length === 0 && (
            <div className="palette-empty">
              {normalized
                ? <>No sessions, repositories, runs, or actions match “{query}”.</>
                : <>No accessible repositories, runs, or sessions.</>}
            </div>
          )}
        </div>
        <footer><span>↑↓ Navigate</span><span>↵ Open</span><span>{repos.length} repositories available</span></footer>
      </section>
    </div>
  );
}
