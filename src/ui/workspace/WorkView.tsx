// Redesign spec §06: one Work screen for everything active, waiting, in
// review, completed or archived — replacing Operations, Sessions, Grid,
// History, Tasks and Signals as destinations. List and Grid are two displays
// of the same filtered items with the same status information. Process
// identity (PID, TTY, origin) lives only under Advanced details.
import { useMemo } from 'react';
import type { AgentMessage, AgentType, Repo } from '../../types.js';
import { type ActivityEntry, deriveActivityTimeline } from '../activityTimeline.js';
import type { WorkLayout } from '../preferences.js';
import { deriveRunResult } from '../../work-engine/run-result.js';
import {
  countWorkBuckets, filterWorkItems, WORK_STATUS_FILTERS, type WorkFilters, type WorkItem,
} from '../workItems.js';
import { Duration } from './model.js';

export interface WorkViewProps {
  items: readonly WorkItem[];
  repos: readonly Repo[];
  events: readonly AgentMessage[];
  filters: WorkFilters;
  layout: WorkLayout;
  onFiltersChange: (filters: WorkFilters) => void;
  onLayoutChange: (layout: WorkLayout) => void;
  onOpen: (item: WorkItem) => void;
  onStartWork: () => void;
}

function latestActivity(item: WorkItem, events: readonly AgentMessage[]): ActivityEntry | undefined {
  if (!item.session) return undefined;
  return deriveActivityTimeline(events, item.session).at(-1);
}

function currentAction(item: WorkItem, activity: ActivityEntry | undefined): string | undefined {
  if (item.run?.pendingAttention) return item.run.pendingAttention.reason;
  if (activity) return activity.detail ? `${activity.label} · ${activity.detail}` : activity.label;
  return undefined;
}

function changedFiles(item: WorkItem, events: readonly AgentMessage[]): string[] {
  if (item.run) return [...(deriveRunResult(item.run)?.changedFiles ?? [])];
  if (!item.session) return [];
  const files = new Set<string>();
  for (const event of events) {
    if (event.event === 'claim' && event.sessionId === item.session.id) for (const file of event.files ?? []) files.add(file);
  }
  return [...files];
}

function AdvancedDetails({ item }: { item: WorkItem }) {
  const { session, run } = item;
  return (
    <details className="work-advanced">
      <summary>Advanced details</summary>
      <dl>
        {session && <>
          <div><dt>Session</dt><dd><code>{session.id}</code></dd></div>
          <div><dt>Origin</dt><dd>{session.origin === 'managed' ? 'Managed by AgentDeck' : `External · ${session.terminalApp ?? 'terminal'}`}</dd></div>
          <div><dt>PID</dt><dd><code>{session.pid ?? '—'}</code></dd></div>
          <div><dt>TTY</dt><dd><code>{session.tty ?? (session.origin === 'managed' ? 'managed PTY' : '—')}</code></dd></div>
          {session.branch && <div><dt>Branch</dt><dd><code>{session.branch}</code></dd></div>}
          <div><dt>Directory</dt><dd><code>{session.cwd}</code></dd></div>
        </>}
        {run && <>
          <div><dt>Run</dt><dd><code>{run.id}</code></dd></div>
          <div><dt>Base</dt><dd><code>{run.spec.requestedBaseReference}</code></dd></div>
          {run.preparation.worktreePath && <div><dt>Worktree</dt><dd><code>{run.preparation.worktreePath}</code></dd></div>}
          {run.attempts && run.attempts.length > 1 && <div><dt>Retries</dt><dd>{run.attempts.length - 1}</dd></div>}
        </>}
      </dl>
    </details>
  );
}

function WorkCard({ item, events, layout, onOpen }: { item: WorkItem; events: readonly AgentMessage[]; layout: WorkLayout; onOpen: () => void }) {
  const activity = latestActivity(item, events);
  const action = currentAction(item, activity);
  const files = changedFiles(item, events);
  return (
    <article className={`work-card tone-${item.tone} bucket-${item.bucket} layout-${layout}`} data-work-id={item.id}>
      <button className="work-card-main" onClick={onOpen} type="button">
        <span className="work-card-head">
          <span className="work-row-status"><i aria-hidden="true" />{item.statusLabel}</span>
          <span className="work-row-time"><Duration since={item.startedAt} /></span>
        </span>
        <strong className="work-card-title" title={item.title}>{item.title}</strong>
        <span className="work-card-meta">{item.agentLabel} · {item.repositoryName}</span>
        {layout === 'grid' && action && <span className="work-card-action">{action}</span>}
      </button>
      {(files.length > 0 || (layout === 'list' && action)) && (
        <details className="work-card-more">
          <summary>{files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'} changed` : 'Current activity'}</summary>
          {action && <p className="work-card-action">{action}</p>}
          {files.length > 0 && <ul className="work-card-files">{files.slice(0, 8).map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
        </details>
      )}
      <AdvancedDetails item={item} />
    </article>
  );
}

export function WorkView({ items, repos, events, filters, layout, onFiltersChange, onLayoutChange, onOpen, onStartWork }: WorkViewProps) {
  // Chip counts respect the repository/agent/search filters but not the status chip itself.
  const scoped = useMemo(() => filterWorkItems(items, { ...filters, status: 'all' }), [items, filters]);
  const counts = useMemo(() => countWorkBuckets(scoped), [scoped]);
  const visible = useMemo(() => filterWorkItems(items, filters), [items, filters]);
  const repository = repos.find((repo) => repo.id === filters.repositoryId);

  return (
    <section className="workspace-scroll work-view">
      <div className="view-heading work-heading">
        <span className="view-heading-copy"><h1>{repository ? `Work · ${repository.name}` : 'Work'}</h1></span>
        <div aria-label="Display" className="segmented-control" role="group">
          <button aria-pressed={layout === 'list'} className={layout === 'list' ? 'is-active' : ''} onClick={() => onLayoutChange('list')} type="button">List</button>
          <button aria-pressed={layout === 'grid'} className={layout === 'grid' ? 'is-active' : ''} onClick={() => onLayoutChange('grid')} type="button">Grid</button>
        </div>
      </div>

      <div aria-label="Status" className="work-status-chips" role="group">
        {WORK_STATUS_FILTERS.map((option) => (
          <button aria-pressed={filters.status === option.id} className={filters.status === option.id ? 'is-active' : ''} key={option.id} onClick={() => onFiltersChange({ ...filters, status: option.id })} type="button">
            {option.label}{counts[option.id] > 0 && <small>{counts[option.id]}</small>}
          </button>
        ))}
      </div>

      <div className="work-filters">
        <input aria-label="Search work" onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })} placeholder="Search work…" type="search" value={filters.query ?? ''} />
        <select aria-label="Repository" onChange={(event) => onFiltersChange({ ...filters, repositoryId: event.target.value || null })} value={filters.repositoryId ?? ''}>
          <option value="">All repositories</option>
          {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
        </select>
        <select aria-label="Agent" onChange={(event) => onFiltersChange({ ...filters, agent: (event.target.value || null) as AgentType | null })} value={filters.agent ?? ''}>
          <option value="">All agents</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>

      {visible.length > 0 ? (
        <div className={layout === 'grid' ? 'work-grid' : 'work-cards'}>
          {visible.map((item) => <WorkCard events={events} item={item} key={item.id} layout={layout} onOpen={() => onOpen(item)} />)}
        </div>
      ) : (
        <div className="empty-workspace">
          <strong>{items.length === 0 ? 'No work yet' : 'Nothing matches these filters'}</strong>
          {items.length === 0
            ? <button className="button button-primary" onClick={onStartWork} type="button">＋ Start work</button>
            : <button className="button" onClick={() => onFiltersChange({ status: 'all' })} type="button">Clear filters</button>}
        </div>
      )}
    </section>
  );
}
