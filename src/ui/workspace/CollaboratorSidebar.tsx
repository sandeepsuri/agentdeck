// The collaborator's navigation rail — modelled directly on AdminSidebar.tsx
// so the two surfaces read as one family. Always mounted (never
// conditionally rendered): at >=901px it sits as the persistent admin-style
// column; collaborator.css turns it into the same off-canvas drawer the
// phone layout already used at <=900px, toggled by `open`. Rendering a
// second copy of this list for the two widths would double every
// [data-repo-id] node the tests rely on, so there is exactly one.
import type { CollaboratorSession, Repo } from '../../types.js';
import type { CollaboratorRunSummary } from '../../work-engine/types.js';
import { isTerminalRunStatus } from './runModel.js';

interface Props {
  repos: readonly Repo[];
  /** Already grant-scoped and authorized — the same list the feed and "Your requests" page read, so a Repository's count here never disagrees with what opening it shows. */
  runs: readonly CollaboratorRunSummary[];
  sessions: readonly CollaboratorSession[];
  selectedRepositoryId: string | null;
  requestsSelected: boolean;
  open: boolean;
  onSelectRepository: (repositoryId: string) => void;
  onSelectRequests: () => void;
  onSelectRun: (runId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewRequest: () => void;
  /** False while no Repository is the active context (e.g. viewing "Your requests") — a request needs a Repository to file it against. */
  canRequestWork: boolean;
}

export function CollaboratorSidebar({
  repos, runs, sessions, selectedRepositoryId, requestsSelected, open, canRequestWork,
  onSelectRepository, onSelectRequests, onSelectRun, onSelectSession, onNewRequest,
}: Props) {
  const attentionRuns = runs.filter((run) => Boolean(run.pendingAttentionKind));
  const attentionSessions = sessions.filter((session) => session.status === 'waiting_input');
  const attentionCount = attentionRuns.length + attentionSessions.length;

  return (
    <aside className={`admin-sidebar collab-sidebar${open ? ' is-open' : ''}`}>
      <div className="admin-sidebar-brand"><span className="brand-mark"><i /></span><strong>AgentDeck</strong></div>
      <nav aria-label="Collaborator navigation" className="admin-navigation">
        <div className="admin-nav-group">
          <div className="admin-nav-label">Work</div>
          <button
            aria-current={requestsSelected ? 'page' : undefined}
            className={requestsSelected ? 'is-active' : ''}
            data-personal-requests
            onClick={onSelectRequests}
            type="button"
          >
            <span aria-hidden="true" className="admin-nav-glyph">☆</span>
            <span>Your requests</span>
          </button>
        </div>
        <div className="admin-nav-group">
          <div className="admin-nav-label">Your repositories</div>
          {repos.map((repo) => {
            const activeRuns = runs.filter((run) => run.repository.id === repo.id && !isTerminalRunStatus(run.status)).length;
            const activeAgents = sessions.filter((item) => item.repoId === repo.id && item.status !== 'exited').length;
            const active = activeRuns + activeAgents;
            return (
              <button
                aria-current={repo.id === selectedRepositoryId ? 'page' : undefined}
                className={repo.id === selectedRepositoryId ? 'is-active' : ''}
                data-repo-id={repo.id}
                key={repo.id}
                onClick={() => onSelectRepository(repo.id)}
                title={repo.name}
                type="button"
              >
                <span aria-hidden="true" className="admin-nav-glyph">▣</span>
                <span className="collab-nav-copy">
                  <strong>{repo.name}</strong>
                  <small>{active > 0 ? `${active} active` : 'Nothing in progress'}</small>
                </span>
              </button>
            );
          })}
          {repos.length === 0 && <p className="sidebar-empty">No Repositories have been granted to you yet.</p>}
        </div>
      </nav>

      {attentionCount > 0 && (
        <section aria-label="Attention" className="admin-sidebar-attention">
          <div className="admin-nav-label">Attention <span>{attentionCount}</span></div>
          {attentionRuns.slice(0, 3).map((run) => (
            <button aria-label={`Open Run needing attention: ${run.objective}`} key={run.id} onClick={() => onSelectRun(run.id)} title={run.objective} type="button">
              <span aria-hidden="true" className="attention-dot" />
              <span><strong>{run.objective}</strong><small>{run.repository.name} · Run</small></span>
            </button>
          ))}
          {attentionSessions.slice(0, Math.max(0, 3 - attentionRuns.length)).map((session) => (
            <button aria-label={`Open agent needing attention: ${session.name ?? session.agent}`} key={session.id} onClick={() => onSelectSession(session.id)} title={session.name ?? session.agent} type="button">
              <span aria-hidden="true" className="attention-dot" />
              <span><strong>{session.name ?? (session.agent === 'claude' ? 'Claude Code' : 'Codex')}</strong><small>Waiting for a reply</small></span>
            </button>
          ))}
        </section>
      )}

      <div className="admin-sidebar-actions collab-sidebar-actions">
        <button
          aria-label="Request new work"
          disabled={!canRequestWork}
          onClick={onNewRequest}
          title={canRequestWork ? undefined : 'Open a Repository to request work'}
          type="button"
        >
          <span aria-hidden="true">＋</span><strong>New request</strong>
        </button>
      </div>

      <footer className="collab-sidebar-footer">
        <span aria-hidden="true" className="mobile-lock">⌁</span>
        <span><strong>Private connection</strong><small>Tailscale protected</small></span>
      </footer>
    </aside>
  );
}
