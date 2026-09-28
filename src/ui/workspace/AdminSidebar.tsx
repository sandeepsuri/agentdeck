// Redesign spec §03, extended by Everyday 04 (#79): the everyday Home leads;
// Overview, Work, Review and Usage sit together under "Developer tools".
// Repositories expand into their chats (the same Work items Home and Work
// list), and the repository name itself still filters Work. Settings sits at
// the foot. The Home badge mirrors the global Needs You queue (needsYou.ts);
// nothing else in the sidebar competes with it.
import { useMemo, useState } from 'react';
import type { Repo } from '../../types.js';
import { inspectorPreferenceStorage, persistExpandedRepositories, readExpandedRepositories } from '../preferences.js';
import type { WorkItem } from '../workItems.js';
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
  workItems: readonly WorkItem[];
  selectedWorkItemId: string | null;
  onView: (view: WorkspaceView) => void;
  onSelectRepository: (repositoryId: string) => void;
  onOpenWorkItem: (item: WorkItem) => void;
  onStartWork: () => void;
  onSettings: () => void;
}

const GLYPHS: Record<WorkspaceView, string> = { home: '⌂', personal: '▤', overview: '▦', work: '◉', review: '±', usage: '◔' };

/** Chats shown under an expanded repository; the rest are one click away in Work. */
const CHATS_PER_REPOSITORY = 5;

const CHAT_STATUS: Partial<Record<WorkItem['bucket'], { tone: string; label: string }>> = {
  working: { tone: 'is-working', label: 'Working' },
  needs_you: { tone: 'is-waiting', label: 'Needs you' },
};
const FAILED_STATUS = { tone: 'is-error', label: 'Failed' };

const GROUPS = [
  { id: 'everyday', label: null },
  { id: 'developer', label: 'Developer tools' },
] as const;

export function AdminSidebar({
  activeView, settingsActive = false, needsYouCount, reviewCount, repos, repositoryActivity, activeRepositoryId,
  workItems, selectedWorkItemId, onView, onSelectRepository, onOpenWorkItem, onStartWork, onSettings,
}: Props) {
  const chatsByRepository = useMemo(() => {
    const chats = new Map<string, WorkItem[]>();
    for (const item of workItems) {
      if (!item.repositoryId || item.bucket === 'archived') continue;
      chats.set(item.repositoryId, [...(chats.get(item.repositoryId) ?? []), item]);
    }
    return chats;
  }, [workItems]);
  // Until the user expands or collapses anything, repositories with work in
  // flight (and the one Work is filtered to) start open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(
    readExpandedRepositories(inspectorPreferenceStorage())
      ?? [...repositoryActivity.keys(), ...(activeRepositoryId ? [activeRepositoryId] : [])],
  ));
  const toggleRepository = (repositoryId: string) => {
    const next = new Set(expanded);
    if (!next.delete(repositoryId)) next.add(repositoryId);
    setExpanded(next);
    persistExpandedRepositories(inspectorPreferenceStorage(), [...next]);
  };
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
        {GROUPS.map((group) => (
          <div role={group.label ? 'group' : undefined} aria-label={group.label ?? undefined} className="admin-nav-group" key={group.id}>
            {group.label && <div aria-hidden="true" className="admin-nav-label">{group.label}</div>}
            {WORKSPACE_VIEWS.filter((view) => view.group === group.id).map(({ id, label }) => {
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
        ))}
      </nav>

      {repos.length > 0 && (
        <nav aria-label="Repositories" className="admin-nav-group sidebar-repositories">
          <div className="admin-nav-label">Repositories</div>
          {repos.map((repo) => {
            const activity = repositoryActivity.get(repo.id);
            const active = activeRepositoryId === repo.id;
            const chats = chatsByRepository.get(repo.id) ?? [];
            const open = expanded.has(repo.id);
            const hidden = chats.length - CHATS_PER_REPOSITORY;
            const running = activity ? activity.active - activity.waiting : 0;
            const state = running > 0 ? ' is-working' : activity && activity.waiting > 0 ? ' is-waiting' : '';
            return (
              <div className={`sidebar-repo${state}`} key={repo.id}>
                <div className={`sidebar-repo-row${active ? ' is-active' : ''}`}>
                  <button aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${repo.name}`} className={`sidebar-repo-toggle${open ? ' is-open' : ''}`} onClick={() => toggleRepository(repo.id)} type="button">
                    <span aria-hidden="true">›</span>
                  </button>
                  <button aria-pressed={active} className={active ? 'is-active' : ''} onClick={() => onSelectRepository(repo.id)} title={`Show work in ${repo.name}`} type="button">
                    <span className="sidebar-repo-name">{repo.name}</span>
                    {running > 0 && <span aria-hidden="true" className="sidebar-repo-activity"><i /><i /><i /></span>}
                    {activity && activity.active > 0 && (
                      <small aria-label={`${activity.active} active${activity.waiting > 0 ? `, ${activity.waiting} waiting` : ''}`} className={activity.waiting > 0 ? 'is-attention' : ''}>
                        <i aria-hidden="true" />{activity.active}
                      </small>
                    )}
                  </button>
                </div>
                {open && chats.length > 0 && (
                  <ul aria-label={`Chats in ${repo.name}`} className="sidebar-chats">
                    {chats.slice(0, CHATS_PER_REPOSITORY).map((item) => {
                      const selected = item.id === selectedWorkItemId;
                      const status = CHAT_STATUS[item.bucket] ?? (item.tone === 'error' ? FAILED_STATUS : undefined);
                      return (
                        <li key={item.id}>
                          <button aria-current={selected ? 'true' : undefined} className={`sidebar-chat${selected ? ' is-selected' : ''}`} onClick={() => onOpenWorkItem(item)} title={item.title} type="button">
                            <span className="sidebar-chat-title">{item.title}</span>
                            <i aria-label={status?.label} className={`sidebar-chat-dot${status ? ` ${status.tone}` : ''}`} role={status ? 'img' : undefined} />
                          </button>
                        </li>
                      );
                    })}
                    {hidden > 0 && (
                      <li>
                        <button className="sidebar-chat sidebar-chat-more" onClick={() => onSelectRepository(repo.id)} type="button">
                          <span className="sidebar-chat-title">Show {hidden} more</span>
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
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
