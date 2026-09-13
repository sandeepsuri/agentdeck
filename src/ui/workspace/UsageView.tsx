// Usage: local Claude Code and Codex token usage (indexed server-side from
// both CLIs' own logs, so sessions started outside AgentDeck count too),
// estimated API-equivalent cost, plan limits, and a model news feed.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repo, Session } from '../../types.js';
import type {
  ModelNewsItem, ModelNewsKind, RateLimitSnapshot, RateLimitWindow, TokenTotals, UsageBucket, UsageModelRow,
  UsagePeriod, UsageProvider, UsageProviderFilter, UsageRange, UsageSessionRow, UsageTimeseriesPoint,
} from '../../usage/types.js';
import { relativeTime } from './model.js';
import { formatTokens, formatUsd, percentChange, providerLabel, useUsageData } from './usageModel.js';

export interface Props {
  active: boolean;
  repos: readonly Repo[];
  sessions: readonly Session[];
  onSelectSession: (session: Session) => void;
}

const PERIOD_LABELS: Record<UsagePeriod, string> = { today: 'Today', week: 'This week', month: 'This month', year: 'This year' };
const RANGE_OPTIONS: { id: UsageRange; label: string }[] = [
  { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, { id: '90d', label: 'Last 90 days' },
  { id: '12mo', label: 'Last 12 months' }, { id: 'all', label: 'All time' },
];
const PROVIDER_OPTIONS: { id: UsageProviderFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' },
];
const BUCKET_OPTIONS: { id: UsageBucket; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string; options: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <div aria-label={label} className="usage-segmented" role="group">
      {options.map((option) => (
        <button aria-pressed={value === option.id} className={value === option.id ? 'is-active' : ''} key={option.id} onClick={() => onChange(option.id)} type="button">{option.label}</button>
      ))}
    </div>
  );
}

function Delta({ current, previous }: { current: number; previous: number }) {
  const change = percentChange(current, previous);
  if (change === undefined) return <span className="usage-delta">no prior data</span>;
  const rounded = Math.round(change);
  return (
    <span className={`usage-delta ${rounded > 0 ? 'is-up' : rounded < 0 ? 'is-down' : ''}`} title="Compared with the same point in the previous period">
      {rounded > 0 ? '▲' : rounded < 0 ? '▼' : '•'} {Math.abs(rounded)}% vs last
    </span>
  );
}

function KpiTile({ period, current, previous }: { period: UsagePeriod; current: TokenTotals; previous: TokenTotals }) {
  return (
    <section aria-label={PERIOD_LABELS[period]} className="usage-kpi">
      <span className="usage-kpi-label">{PERIOD_LABELS[period]}</span>
      <strong className="usage-kpi-value">{formatTokens(current.totalTokens)}<small> tokens</small></strong>
      <span className="usage-kpi-cost">{formatUsd(current.costUsd)} <small>est. API cost</small></span>
      <span className="usage-kpi-split">{formatTokens(current.inputTokens)} in · {formatTokens(current.outputTokens)} out · {formatTokens(current.cacheReadTokens + current.cacheWriteTokens)} cache</span>
      <Delta current={current.totalTokens} previous={previous.totalTokens} />
    </section>
  );
}

// --- chart -------------------------------------------------------------------

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, entry.contentRect.width)); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** A bar segment with a rounded top and a square base, as data-ends should read. */
function topRoundedPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function bucketLabel(bucket: string, size: UsageBucket, long = false): string {
  const date = new Date(`${bucket}T00:00:00`);
  if (size === 'month') return date.toLocaleDateString([], long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  const text = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return size === 'week' && long ? `Week of ${text}` : text;
}

function UsageChart({ points, bucket, provider }: { points: UsageTimeseriesPoint[]; bucket: UsageBucket; provider: UsageProviderFilter }) {
  const { ref, width } = useWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const margin = { top: 12, right: 8, bottom: 26, left: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const series: UsageProvider[] = provider === 'all' ? ['claude', 'codex'] : [provider];
  const totals = points.map((point) => series.reduce((sum, key) => sum + point[key].totalTokens, 0));
  const max = niceMax(Math.max(0, ...totals));
  const slot = points.length > 0 ? plotWidth / points.length : plotWidth;
  const barWidth = Math.max(2, Math.min(28, slot * 0.64));
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / 64))));
  const hovered = hover !== null ? points[hover] : undefined;

  if (points.every((point) => series.every((key) => point[key].events === 0))) {
    return <div className="empty-workspace compact"><strong>No usage in this range</strong><span>Tokens appear here as Claude Code and Codex sessions run.</span></div>;
  }

  return (
    <div className="usage-chart" ref={ref}>
      {series.length > 1 && (
        <div className="usage-legend" aria-hidden="true">
          {series.map((key) => <span key={key}><i className={`usage-swatch provider-${key}`} />{providerLabel(key)}</span>)}
        </div>
      )}
      <svg aria-label={`Tokens per ${bucket}`} height={height} role="img" width={width}>
        {[0, 0.5, 1].map((fraction) => {
          const y = margin.top + plotHeight * (1 - fraction);
          return (
            <g key={fraction}>
              <line className="usage-grid" x1={margin.left} x2={width - margin.right} y1={y} y2={y} />
              <text className="usage-axis" textAnchor="end" x={margin.left - 8} y={y + 3}>{formatTokens(max * fraction)}</text>
            </g>
          );
        })}
        {points.map((point, index) => {
          const x = margin.left + index * slot + (slot - barWidth) / 2;
          let base = margin.top + plotHeight;
          const segments = series.map((key) => ({ key, value: point[key].totalTokens })).filter((segment) => segment.value > 0);
          return (
            <g key={point.bucket}>
              {segments.map((segment, segmentIndex) => {
                const segmentHeight = (segment.value / max) * plotHeight;
                // 2px surface gap between stacked segments.
                const gap = segmentIndex > 0 ? 2 : 0;
                const drawn = Math.max(0, segmentHeight - gap);
                base -= segmentHeight;
                const isTop = segmentIndex === segments.length - 1;
                return drawn > 0 && (
                  <path
                    className={`usage-bar provider-${segment.key}${hover !== null && hover !== index ? ' is-dimmed' : ''}`}
                    d={isTop ? topRoundedPath(x, base, barWidth, drawn, 4) : `M${x},${base + drawn} V${base} H${x + barWidth} V${base + drawn} Z`}
                    key={segment.key}
                  />
                );
              })}
              {index % labelEvery === 0 && (
                <text className="usage-axis" textAnchor="middle" x={x + barWidth / 2} y={height - 8}>{bucketLabel(point.bucket, bucket)}</text>
              )}
              <rect
                className="usage-hit"
                height={plotHeight}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
                width={slot}
                x={margin.left + index * slot}
                y={margin.top}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div className="usage-tooltip" role="status" style={{ left: Math.min(width - 190, Math.max(0, margin.left + hover * slot + slot / 2 - 90)) }}>
          <strong>{bucketLabel(hovered.bucket, bucket, true)}</strong>
          {series.map((key) => (
            <span key={key}><i className={`usage-swatch provider-${key}`} />{providerLabel(key)}<b>{formatTokens(hovered[key].totalTokens)}</b><em>{formatUsd(hovered[key].costUsd)}</em></span>
          ))}
        </div>
      )}
      <table className="sr-only">
        <caption>Tokens per {bucket}</caption>
        <thead><tr><th>{bucket}</th>{series.map((key) => <th key={key}>{providerLabel(key)} tokens</th>)}</tr></thead>
        <tbody>{points.map((point) => <tr key={point.bucket}><td>{point.bucket}</td>{series.map((key) => <td key={key}>{point[key].totalTokens}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// --- models, limits, sessions, news -------------------------------------------

function ModelsPanel({ models }: { models: UsageModelRow[] }) {
  if (models.length === 0) return <div className="overview-empty-row">No models used in this range.</div>;
  const top = models[0]?.totalTokens ?? 1;
  return (
    <ol className="usage-models">
      {models.map((model) => (
        <li key={`${model.provider}:${model.model}`}>
          <div className="usage-model-head">
            <span className="usage-model-name"><i className={`usage-swatch provider-${model.provider}`} /><strong className="mono">{model.model}</strong></span>
            <span className="usage-model-share">{(model.share * 100).toFixed(model.share < 0.01 ? 1 : 0)}%</span>
          </div>
          <div aria-hidden="true" className="usage-share-track"><span className={`provider-${model.provider}`} style={{ width: `${Math.max(1, (model.totalTokens / top) * 100)}%` }} /></div>
          <div className="usage-model-meta">
            <span>{formatTokens(model.totalTokens)} tokens</span>
            <span>{formatTokens(model.inputTokens)} in · {formatTokens(model.outputTokens)} out</span>
            <span>{model.priced ? formatUsd(model.costUsd) : 'no price'}</span>
            <span title={new Date(model.lastUsedAt).toLocaleString()}>{relativeTime(model.lastUsedAt)} ago</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function windowLabel(window: RateLimitWindow): string {
  if (window.windowMinutes === 10_080) return 'Weekly limit';
  if (window.windowMinutes >= 60) return `${Math.round(window.windowMinutes / 60)}-hour limit`;
  return `${window.windowMinutes}-minute limit`;
}

function LimitMeter({ window }: { window: RateLimitWindow }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const level = used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'good';
  const resetsIn = window.resetsAt ? new Date(window.resetsAt).getTime() - Date.now() : undefined;
  return (
    <div className={`usage-limit is-${level}`}>
      <div className="usage-limit-head">
        <span>{windowLabel(window)}</span>
        <strong>{level !== 'good' && <span aria-hidden="true">{level === 'critical' ? '⚠ ' : '△ '}</span>}{Math.round(used)}% used</strong>
      </div>
      <div aria-label={`${Math.round(used)}% of ${windowLabel(window).toLowerCase()} used`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(used)} className="usage-limit-track" role="meter">
        <span style={{ width: `${used}%` }} />
      </div>
      {window.resetsAt && (
        <small title={new Date(window.resetsAt).toLocaleString()}>
          {resetsIn !== undefined && resetsIn > 0 ? `Resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Reset time has passed — refreshes on next Codex turn'}
        </small>
      )}
    </div>
  );
}

function LimitsPanel({ limits, provider }: { limits: RateLimitSnapshot[]; provider: UsageProviderFilter }) {
  const codex = limits.find((limit) => limit.provider === 'codex');
  return (
    <div className="usage-limits">
      {provider !== 'claude' && (
        <div className="usage-limit-group">
          <div className="usage-limit-provider"><i className="usage-swatch provider-codex" />Codex{codex?.planType && <span className="usage-plan">{codex.planType}</span>}</div>
          {codex?.primary && <LimitMeter window={codex.primary} />}
          {codex?.secondary && <LimitMeter window={codex.secondary} />}
          {codex ? <small className="usage-muted">As of {relativeTime(codex.observedAt)} ago</small> : <small className="usage-muted">No plan limits reported yet.</small>}
        </div>
      )}
      {provider !== 'codex' && (
        <div className="usage-limit-group">
          <div className="usage-limit-provider"><i className="usage-swatch provider-claude" />Claude Code</div>
          <small className="usage-muted">Claude Code doesn&apos;t write plan limits to its local logs. Run <code>/usage</code> in Claude Code to see them.</small>
        </div>
      )}
    </div>
  );
}

type SessionSort = 'lastActivityAt' | 'totalTokens' | 'inputCostUsd' | 'outputCostUsd' | 'costUsd';

function SessionsTable({ rows, repos, sessions, onSelectSession }: {
  rows: UsageSessionRow[]; repos: readonly Repo[]; sessions: readonly Session[]; onSelectSession: (session: Session) => void;
}) {
  const [sort, setSort] = useState<SessionSort>('lastActivityAt');
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === 'lastActivityAt'
    ? b.lastActivityAt.localeCompare(a.lastActivityAt)
    : b[sort] - a[sort]), [rows, sort]);
  if (rows.length === 0) return <div className="overview-empty-row">No sessions in this range.</div>;
  const header = (key: SessionSort, label: string, numeric = true) => (
    <th aria-sort={sort === key ? 'descending' : 'none'} className={numeric ? 'is-numeric' : ''} scope="col">
      <button onClick={() => setSort(key)} type="button">{label}{sort === key ? ' ↓' : ''}</button>
    </th>
  );
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Model</th>
            {header('lastActivityAt', 'Last active', false)}
            <th className="is-numeric" scope="col">Input</th>
            <th className="is-numeric" scope="col">Output</th>
            <th className="is-numeric" scope="col">Cache</th>
            {header('inputCostUsd', 'Input $')}
            {header('outputCostUsd', 'Output $')}
            {header('costUsd', 'Total $')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const managed = sessions.find((session) => session.agentSessionId === row.sessionId || session.id === row.sessionId);
            const repo = row.cwd ? repos.find((candidate) => row.cwd === candidate.path || row.cwd?.startsWith(`${candidate.path}/`)) : undefined;
            const place = repo?.name ?? row.cwd?.split('/').filter(Boolean).pop() ?? 'Unknown directory';
            const priced = row.unpricedTokens < row.totalTokens;
            return (
              <tr key={`${row.provider}:${row.sessionId}`}>
                <td>
                  <span className="usage-session-cell">
                    <i className={`usage-swatch provider-${row.provider}`} />
                    <span>
                      {managed
                        ? <button className="usage-link" onClick={() => onSelectSession(managed)} title="Open this session" type="button">{place}</button>
                        : <strong title={row.cwd}>{place}</strong>}
                      <small className="mono">{providerLabel(row.provider)} · {row.sessionId.slice(0, 8)}</small>
                    </span>
                  </span>
                </td>
                <td className="mono usage-models-cell" title={row.models.join(', ')}>{row.models.join(', ')}</td>
                <td title={new Date(row.lastActivityAt).toLocaleString()}>{relativeTime(row.lastActivityAt)} ago</td>
                <td className="is-numeric">{formatTokens(row.inputTokens)}</td>
                <td className="is-numeric">{formatTokens(row.outputTokens)}</td>
                <td className="is-numeric">{formatTokens(row.cacheReadTokens + row.cacheWriteTokens)}</td>
                <td className="is-numeric">{priced ? formatUsd(row.inputCostUsd) : '—'}</td>
                <td className="is-numeric">{priced ? formatUsd(row.outputCostUsd) : '—'}</td>
                <td className="is-numeric"><strong>{priced ? formatUsd(row.costUsd) : '—'}</strong></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const NEWS_KIND_LABELS: Record<ModelNewsKind, string> = {
  launch: 'New', update: 'Update', deprecation: 'Deprecation', retirement: 'Retired', 'first-seen': 'First used',
};
type NewsFilter = 'all' | 'launch' | 'deprecation' | 'mine';
const NEWS_FILTERS: { id: NewsFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'launch', label: 'New' }, { id: 'deprecation', label: 'Deprecations' }, { id: 'mine', label: 'Mine' },
];

function newsMatches(item: ModelNewsItem, filter: NewsFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'launch') return item.kind === 'launch';
  if (filter === 'deprecation') return item.kind === 'deprecation' || item.kind === 'retirement';
  return item.kind === 'first-seen' || Boolean(item.affectsModels?.length);
}

function NewsFeed({ items, lastError, lastFetchedAt }: { items: ModelNewsItem[]; lastError?: string; lastFetchedAt?: string }) {
  const [filter, setFilter] = useState<NewsFilter>('all');
  const visible = items.filter((item) => newsMatches(item, filter));
  return (
    <section aria-label="Model news" className="usage-card usage-news">
      <header className="usage-card-header">
        <div><strong>Model news</strong><small>{lastFetchedAt ? `Checked ${relativeTime(lastFetchedAt)} ago` : 'Anthropic & OpenAI docs'}</small></div>
      </header>
      <Segmented label="Filter model news" onChange={setFilter} options={NEWS_FILTERS} value={filter} />
      {lastError && <p className="usage-news-error">Feed partly unavailable: {lastError}. Showing cached entries.</p>}
      <ol className="usage-news-list">
        {visible.map((item) => (
          <li className={`usage-news-item kind-${item.kind}`} key={item.id}>
            <div className="usage-news-meta">
              <span className={`usage-news-badge kind-${item.kind}`}>{NEWS_KIND_LABELS[item.kind]}</span>
              <span>{item.provider === 'anthropic' ? 'Anthropic' : item.provider === 'openai' ? 'OpenAI' : 'Your usage'}</span>
              <time dateTime={item.publishedAt}>{new Date(`${item.publishedAt.slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</time>
            </div>
            <p className="usage-news-title">{item.url ? <a href={item.url} rel="noreferrer" target="_blank">{item.title}</a> : item.title}</p>
            {item.detail && <p className="usage-news-detail">{item.detail}</p>}
            {item.affectsModels && item.affectsModels.length > 0 && (
              <p className="usage-news-affects"><span aria-hidden="true">⚠ </span>You&apos;ve used {item.affectsModels.join(', ')}</p>
            )}
          </li>
        ))}
        {visible.length === 0 && <li className="overview-empty-row">{items.length === 0 ? 'No model news yet — the feed checks provider docs every few hours.' : 'Nothing matches this filter.'}</li>}
      </ol>
    </section>
  );
}

export function UsageView({ active, repos, sessions, onSelectSession }: Props) {
  const [provider, setProvider] = useState<UsageProviderFilter>('all');
  const [range, setRange] = useState<UsageRange>('30d');
  const [bucket, setBucket] = useState<UsageBucket>('day');
  const { data, error, loading, refreshing, refresh } = useUsageData(active, { provider, range, bucket });
  const { summary } = data;
  const rangeLabel = RANGE_OPTIONS.find((option) => option.id === range)?.label ?? '';
  const rangeTotals = data.models.reduce((sum, model) => ({ tokens: sum.tokens + model.totalTokens, cost: sum.cost + model.costUsd }), { tokens: 0, cost: 0 });

  return (
    <section className="workspace-scroll usage-view">
      <div className="view-heading usage-heading">
        <div className="view-heading-copy">
          <h1>Usage</h1>
          <span>
            Claude Code + Codex, from local logs
            {summary?.indexing ? ' · indexing…' : summary?.indexedAt ? ` · updated ${relativeTime(summary.indexedAt)} ago` : ''}
          </span>
        </div>
        <div className="usage-controls">
          <Segmented label="Provider" onChange={setProvider} options={PROVIDER_OPTIONS} value={provider} />
          <select aria-label="Date range" onChange={(event) => setRange(event.target.value as UsageRange)} value={range}>
            {RANGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button className="button compact-button" disabled={refreshing} onClick={() => void refresh()} type="button">{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      {error && <div className="usage-error" role="alert">Couldn&apos;t load usage: {error}</div>}
      {!summary && loading && !error && <div className="empty-workspace compact"><strong>Reading usage logs…</strong><span>The first scan of ~/.claude and ~/.codex can take a few seconds.</span></div>}

      {summary && (
        <>
          <div className="usage-kpis">
            {summary.periods.map((period) => <KpiTile current={period.current} key={period.period} period={period.period} previous={period.previous} />)}
          </div>

          <div className="usage-layout">
            <div className="usage-main">
              <section aria-label="Usage over time" className="usage-card">
                <header className="usage-card-header">
                  <div><strong>Usage over time</strong><small>{rangeLabel} · {formatTokens(rangeTotals.tokens)} tokens · {formatUsd(rangeTotals.cost)} est.</small></div>
                  <Segmented label="Bucket size" onChange={setBucket} options={BUCKET_OPTIONS} value={bucket} />
                </header>
                <UsageChart bucket={bucket} points={data.timeseries} provider={provider} />
              </section>

              <section aria-label="Sessions" className="usage-card">
                <header className="usage-card-header">
                  <div><strong>Sessions</strong><small>Per-session tokens and estimated cost · {rangeLabel.toLowerCase()}</small></div>
                </header>
                <SessionsTable onSelectSession={onSelectSession} repos={repos} rows={data.sessions} sessions={sessions} />
              </section>
            </div>

            <aside className="usage-rail">
              <section aria-label="Models" className="usage-card">
                <header className="usage-card-header"><div><strong>Models</strong><small>{rangeLabel}</small></div></header>
                <ModelsPanel models={data.models} />
              </section>
              <section aria-label="Plan limits" className="usage-card">
                <header className="usage-card-header"><div><strong>Plan limits</strong></div></header>
                <LimitsPanel limits={data.rateLimits} provider={provider} />
              </section>
              <NewsFeed items={data.news?.items ?? []} lastError={data.news?.lastError} lastFetchedAt={data.news?.lastFetchedAt} />
            </aside>
          </div>
          <p className="usage-footnote">Costs are estimates at public API rates (standard tier) and don&apos;t reflect subscription billing. Totals include cache reads. Override prices with <code>usagePricing</code> in ~/.agentdeck/config.json.</p>
        </>
      )}
    </section>
  );
}
