// Developer tools › Overview (#79): the developer dashboard that was Home
// before the everyday Home took that place. Order is unchanged minus Needs
// You, which lives on Home: active work, compact usage, repositories, recent
// completions. Every action routes through handlers App.tsx already owns.
import { useEffect, useState } from 'react';
import type { Repo } from '../../types.js';
import type { RateLimitSnapshot, UsageSummary } from '../../usage/types.js';
import { apiFetch, responseJson } from '../apiFetch.js';
import type { WorkItem } from '../workItems.js';
import type { RepositoryActivity } from './AdminSidebar.js';
import { formatUsd, providerLabel } from './usageModel.js';
import { WorkRow } from './WorkRow.js';

export interface DeveloperOverviewProps {
  workItems: readonly WorkItem[];
  repos: readonly Repo[];
  repositoryActivity: ReadonlyMap<string, RepositoryActivity>;
  rateLimits: readonly RateLimitSnapshot[];
  /** Loads the monthly spend glance; off while Overview is hidden. */
  active?: boolean;
  onStartWork: () => void;
  onOpenWorkItem: (item: WorkItem) => void;
  onSelectRepository: (repositoryId: string) => void;
  onOpenUsage: () => void;
}

function UsageGlance({ rateLimits, active, onOpen }: { rateLimits: readonly RateLimitSnapshot[]; active: boolean; onOpen: () => void }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const load = () => apiFetch('/api/usage/summary').then((response) => responseJson<UsageSummary>(response))
      .then((next) => { if (!disposed) setSummary(next); }).catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => { disposed = true; clearInterval(id); };
  }, [active]);

  const month = summary?.periods.find((entry) => entry.period === 'month')?.current;
  const limits = rateLimits.flatMap((snapshot) => [snapshot.primary, snapshot.secondary]
    .filter((window): window is NonNullable<typeof window> => Boolean(window))
    .map((window) => ({ provider: snapshot.provider, window })));
  const highest = limits.sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
  if (!month && !highest) return null;
  return (
    <button aria-label="Open usage" className="home-usage-glance" onClick={onOpen} type="button">
      {month && <span><small>Usage this month</small><strong>{formatUsd(month.costUsd)}</strong></span>}
      {highest && (
        <span>
          <small>{providerLabel(highest.provider)} {highest.window.windowMinutes >= 10_080 ? 'weekly' : highest.window.windowMinutes >= 1_440 ? 'daily' : `${Math.round(highest.window.windowMinutes / 60)}-hour`} limit</small>
          <strong>{Math.round(highest.window.usedPercent)}%</strong>
        </span>
      )}
      <span aria-hidden="true" className="home-usage-go">›</span>
    </button>
  );
}

export function DeveloperOverview({
  workItems, repos, repositoryActivity, rateLimits, active = true,
  onStartWork, onOpenWorkItem, onSelectRepository, onOpenUsage,
}: DeveloperOverviewProps) {
  const activeWork = workItems.filter((item) => item.bucket === 'working' || item.bucket === 'needs_you').slice(0, 8);
  const recent = workItems.filter((item) => item.bucket === 'completed' || item.bucket === 'review')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <section className="workspace-scroll home-view">
      <div className="view-heading home-heading">
        <h1>Overview</h1>
        <button className="button button-primary" onClick={onStartWork} type="button">＋ Start work</button>
      </div>

      <section aria-labelledby="overview-active-work" className="home-section">
        <header className="home-section-header"><h2 id="overview-active-work">Active work</h2></header>
        {activeWork.length > 0
          ? <div className="work-list">{activeWork.map((item) => <WorkRow item={item} key={item.id} onOpen={() => onOpenWorkItem(item)} />)}</div>
          : <p className="home-empty">No agents are working. <button className="text-button" onClick={onStartWork} type="button">Start work</button></p>}
      </section>

      <UsageGlance active={active} onOpen={onOpenUsage} rateLimits={rateLimits} />

      {repos.length > 0 && (
        <section aria-labelledby="overview-repositories" className="home-section">
          <header className="home-section-header"><h2 id="overview-repositories">Repositories</h2></header>
          <div className="home-repo-grid">
            {repos.map((repo) => {
              const activity = repositoryActivity.get(repo.id) ?? { active: 0, waiting: 0 };
              return (
                <button className="home-repo-card" key={repo.id} onClick={() => onSelectRepository(repo.id)} type="button">
                  <strong>{repo.name}</strong>
                  <small>⎇ {repo.currentBranch ?? 'unknown'}</small>
                  <span>{activity.active} active{activity.waiting > 0 ? <em> · {activity.waiting} waiting</em> : ''}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section aria-labelledby="overview-recent" className="home-section">
          <header className="home-section-header"><h2 id="overview-recent">Recently finished</h2></header>
          <div className="work-list">{recent.map((item) => <WorkRow item={item} key={item.id} onOpen={() => onOpenWorkItem(item)} />)}</div>
        </section>
      )}
    </section>
  );
}
