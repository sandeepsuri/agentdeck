// Redesign spec §04: Home answers "what needs me?" before anything passive.
// Order is fixed: Needs You, active work, compact usage, repositories, recent
// completions. Every action routes through handlers App.tsx already owns
// (resolveRunAttention, opening a Run/Session) — Home adds no new write path.
import { useEffect, useState } from 'react';
import type { Repo } from '../../types.js';
import type { RateLimitSnapshot, UsageSummary } from '../../usage/types.js';
import type { AttentionDecisionInput, WorkRun } from '../../work-engine/types.js';
import { apiFetch, responseJson } from '../apiFetch.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import type { NeedsYouItem } from '../needsYou.js';
import type { WorkItem } from '../workItems.js';
import type { RepositoryActivity } from './AdminSidebar.js';
import { Duration } from './model.js';
import { formatUsd, providerLabel } from './usageModel.js';

export interface HomeViewProps {
  needsYou: readonly NeedsYouItem[];
  workItems: readonly WorkItem[];
  runs: readonly WorkRun[];
  repos: readonly Repo[];
  repositoryActivity: ReadonlyMap<string, RepositoryActivity>;
  rateLimits: readonly RateLimitSnapshot[];
  /** Loads the monthly spend glance; off while Home is hidden. */
  active?: boolean;
  onStartWork: () => void;
  onOpenNeedsYou: (item: NeedsYouItem) => void;
  onOpenWorkItem: (item: WorkItem) => void;
  onSelectRepository: (repositoryId: string) => void;
  onOpenUsage: () => void;
  onResolveRunAttention: (runId: string, attentionId: string, decision: AttentionDecisionInput) => Promise<void> | void;
}

const KIND_GLYPH: Record<NeedsYouItem['kind'], string> = {
  permission: '⚠', question: '?', conflict: '△', error: '✕', usage: '◔', review: '◉',
};

function InlineAnswer({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form className="needs-you-answer" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input aria-label="Your answer" autoFocus onChange={(event) => setValue(event.target.value)} placeholder="Type your answer…" value={value} />
      <button className="button button-primary" disabled={!value.trim()} type="submit">Send</button>
    </form>
  );
}

function NeedsYouRow({ item, run, onOpen, onResolve }: {
  item: NeedsYouItem;
  run: WorkRun | undefined;
  onOpen: () => void;
  onResolve: HomeViewProps['onResolveRunAttention'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Inline only where acting here is exactly what the detail page would do:
  // a pending Run approval or input request. Everything else opens its work.
  const pending = item.target.kind === 'run' && run?.pendingAttention && run.pendingAttention.id === item.target.attentionId ? run.pendingAttention : undefined;
  const resolve = async (decision: AttentionDecisionInput) => {
    if (!run || !pending) return;
    setBusy(true);
    try { await onResolve(run.id, pending.id, decision); } finally { setBusy(false); }
  };
  return (
    <li className={`needs-you-item kind-${item.kind}`}>
      <div className="needs-you-summary">
        <span aria-hidden="true" className="needs-you-glyph">{KIND_GLYPH[item.kind]}</span>
        <span className="needs-you-copy">
          <strong>{item.title}</strong>
          <small>{item.context}</small>
          {item.detail && !expanded && <code>{item.detail}</code>}
        </span>
        <button
          aria-expanded={pending ? expanded : undefined}
          className={`button${item.kind === 'permission' || item.kind === 'question' ? ' button-primary' : ''}`}
          onClick={() => (pending ? setExpanded((current) => !current) : onOpen())}
          type="button"
        >
          {pending && expanded ? 'Close' : item.action}
        </button>
      </div>
      {pending && expanded && run && (pending.kind === 'approval'
        ? (
          <ApprovalCard
            busy={busy}
            fallbackAgent={run.spec.runtimePreference[0] === 'codex' ? 'Codex' : 'Claude'}
            intent={run.spec.objective}
            onApprove={() => void resolve({ kind: 'approve' })}
            onDeny={() => void resolve({ kind: 'deny' })}
            reason={pending.reason}
            repositoryName={run.spec.repository.name}
            {...(run.preparation.worktreePath ? { workingDirectory: run.preparation.worktreePath } : {})}
          />
        )
        : <InlineAnswer onSubmit={(value) => void resolve({ kind: 'input', value })} />)}
    </li>
  );
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

function WorkRow({ item, onOpen }: { item: WorkItem; onOpen: () => void }) {
  return (
    <button className={`work-row tone-${item.tone}`} onClick={onOpen} type="button">
      <span className="work-row-agent">{item.agentLabel}</span>
      <strong className="work-row-title" title={item.title}>{item.title}</strong>
      <span className="work-row-repo">{item.repositoryName}</span>
      <span className="work-row-status"><i aria-hidden="true" />{item.statusLabel}</span>
      <span className="work-row-time"><Duration since={item.startedAt} /></span>
    </button>
  );
}

export function HomeView({
  needsYou, workItems, runs, repos, repositoryActivity, rateLimits, active = true,
  onStartWork, onOpenNeedsYou, onOpenWorkItem, onSelectRepository, onOpenUsage, onResolveRunAttention,
}: HomeViewProps) {
  const activeWork = workItems.filter((item) => item.bucket === 'working' || item.bucket === 'needs_you').slice(0, 8);
  const recent = workItems.filter((item) => item.bucket === 'completed' || item.bucket === 'review')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <section className="workspace-scroll home-view">
      <div className="view-heading home-heading">
        <h1>Home</h1>
        <button className="button button-primary" onClick={onStartWork} type="button">＋ Start work</button>
      </div>

      <section aria-labelledby="home-needs-you" className="home-section">
        <header className="home-section-header"><h2 id="home-needs-you">Needs you</h2>{needsYou.length > 0 && <span className="home-count">{needsYou.length}</span>}</header>
        {needsYou.length > 0 ? (
          <ol className="needs-you-list">
            {needsYou.map((item) => (
              <NeedsYouRow
                item={item}
                key={item.id}
                onOpen={() => onOpenNeedsYou(item)}
                onResolve={onResolveRunAttention}
                run={item.target.kind === 'run' ? runs.find((run) => run.id === (item.target as { runId: string }).runId) : undefined}
              />
            ))}
          </ol>
        ) : <p className="home-empty">Nothing needs you right now.</p>}
      </section>

      <section aria-labelledby="home-active-work" className="home-section">
        <header className="home-section-header"><h2 id="home-active-work">Active work</h2></header>
        {activeWork.length > 0
          ? <div className="work-list">{activeWork.map((item) => <WorkRow item={item} key={item.id} onOpen={() => onOpenWorkItem(item)} />)}</div>
          : <p className="home-empty">No agents are working. <button className="text-button" onClick={onStartWork} type="button">Start work</button></p>}
      </section>

      <UsageGlance active={active} onOpen={onOpenUsage} rateLimits={rateLimits} />

      {repos.length > 0 && (
        <section aria-labelledby="home-repositories" className="home-section">
          <header className="home-section-header"><h2 id="home-repositories">Repositories</h2></header>
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
        <section aria-labelledby="home-recent" className="home-section">
          <header className="home-section-header"><h2 id="home-recent">Recently finished</h2></header>
          <div className="work-list">{recent.map((item) => <WorkRow item={item} key={item.id} onOpen={() => onOpenWorkItem(item)} />)}</div>
        </section>
      )}
    </section>
  );
}
