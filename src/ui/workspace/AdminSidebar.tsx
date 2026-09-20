// Redesign spec §03: four primary destinations, repositories as contextual
// filters rather than a navigation tree, and Settings at the foot. The Home
// badge mirrors the global Needs You queue (needsYou.ts); nothing else in the
// sidebar competes with it.
import type { Repo } from '../../types.js';
import { type WorkspaceView, WORKSPACE_VIEWS } from './model.js';

export interface RepositoryActivity {
  active: number;
  waiting: number;
}

interface Props {
  activeView: WorkspaceView;
  settingsActive?: boolean;
  needsYouCount: number;
  reviewCount: number;
  repos: readonly Repo[];
  repositoryActivity: ReadonlyMap<string, RepositoryActivity>;
  activeRepositoryId: string | null;
  onView: (view: WorkspaceView) => void;
  onSelectRepository: (repositoryId: string) => void;
  onStartWork: () => void;
  onSettings: () => void;
}

const GLYPHS: Record<WorkspaceView, string> = { home: '⌂', work: '◉', review: '±', usage: '◔' };

export function AdminSidebar({
  activeView, settingsActive = false, needsYouCount, reviewCount, repos, repositoryActivity, activeRepositoryId,
  onView, onSelectRepository, onStartWork, onSettings,
}: Props) {
  const badges: Partial<Record<WorkspaceView, { count: number; label: string }>> = {
    home: { count: needsYouCount, label: `${needsYouCount} item${needsYouCount === 1 ? '' : 's'} need you` },
    review: { count: reviewCount, label: `${reviewCount} ready for review` },
  };
  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-brand"><span className="brand-mark"><i /></span><strong>AgentDeck</strong></div>
      <button className="button button-primary sidebar-start-work" onClick={onStartWork} title="Start work (⌘L)" type="button">
        <span aria-hidden="true">＋</span><strong>Start work</strong>
      </button>
      <nav aria-label="Admin navigation" className="admin-navigation">
        <div className="admin-nav-group">
          {WORKSPACE_VIEWS.map(({ id, label }) => {
            const active = !settingsActive && activeView === id;
            const badge = badges[id];
            return (
              <button aria-current={active ? 'page' : undefined} className={active ? 'is-active' : ''} key={id} onClick={() => onView(id)} title={label} type="button">
                <span aria-hidden="true" className="admin-nav-glyph">{GLYPHS[id]}</span>
                <span>{label}</span>
                {badge && badge.count > 0 && <small aria-label={badge.label} className={id === 'home' ? 'is-attention' : ''}>{badge.count}</small>}
              </button>
            );
          })}
        </div>
      </nav>

      {repos.length > 0 && (
        <nav aria-label="Repositories" className="admin-nav-group sidebar-repositories">
          <div className="admin-nav-label">Repositories</div>
          {repos.map((repo) => {
            const activity = repositoryActivity.get(repo.id);
            const active = activeRepositoryId === repo.id;
            return (
              <button aria-pressed={active} className={active ? 'is-active' : ''} key={repo.id} onClick={() => onSelectRepository(repo.id)} title={`Show work in ${repo.name}`} type="button">
                <span className="sidebar-repo-name">{repo.name}</span>
                {activity && activity.active > 0 && (
                  <small aria-label={`${activity.active} active${activity.waiting > 0 ? `, ${activity.waiting} waiting` : ''}`} className={activity.waiting > 0 ? 'is-attention' : ''}>
                    <i aria-hidden="true" />{activity.active}
                  </small>
                )}
              </button>
            );
          })}
        </nav>
      )}

      <div className="admin-sidebar-actions">
        <button aria-current={settingsActive ? 'page' : undefined} className={settingsActive ? 'is-active' : ''} onClick={onSettings} title="Settings" type="button">
          <span aria-hidden="true">⚙</span><strong>Settings</strong>
        </button>
      </div>
    </aside>
  );
}
