// Formatting and fetching shared by UsageView and the Overview usage strip.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, responseJson } from '../apiFetch.js';
import type {
  ModelNewsFeed, RateLimitSnapshot, TokenTotals, UsageBucket, UsageModelRow, UsageProviderFilter, UsageRange,
  UsageSessionRow, UsageSummary, UsageTimeseriesPoint,
} from '../../usage/types.js';

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/** Signed percent change, or undefined when there's no baseline to compare with. */
export function percentChange(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

export function providerLabel(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

export function hasCost(totals: TokenTotals): boolean {
  return totals.costUsd > 0 || totals.unpricedTokens < totals.totalTokens;
}

export interface UsageData {
  summary?: UsageSummary;
  timeseries: UsageTimeseriesPoint[];
  models: UsageModelRow[];
  sessions: UsageSessionRow[];
  rateLimits: RateLimitSnapshot[];
  news?: ModelNewsFeed;
}

export interface UsageFilters {
  provider: UsageProviderFilter;
  range: UsageRange;
  bucket: UsageBucket;
}

const EMPTY: UsageData = { timeseries: [], models: [], sessions: [], rateLimits: [] };

/** Loads every Usage panel while `active`, and re-polls each minute until it isn't. */
export function useUsageData(active: boolean, filters: UsageFilters) {
  const [data, setData] = useState<UsageData>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { provider, range, bucket } = filters;

  const load = useCallback(async () => {
    const qs = (extra: Record<string, string>) => new URLSearchParams({ provider, ...extra }).toString();
    const get = <T,>(url: string) => apiFetch(url).then((response) => responseJson<T>(response));
    setLoading(true);
    try {
      const [summary, timeseries, models, sessions, rateLimits, news] = await Promise.all([
        get<UsageSummary>(`/api/usage/summary?${qs({})}`),
        get<UsageTimeseriesPoint[]>(`/api/usage/timeseries?${qs({ bucket, range })}`),
        get<UsageModelRow[]>(`/api/usage/models?${qs({ range })}`),
        get<UsageSessionRow[]>(`/api/usage/sessions?${qs({ range, limit: '200' })}`),
        get<RateLimitSnapshot[]>('/api/usage/rate-limits'),
        get<ModelNewsFeed>('/api/usage/news').catch(() => undefined),
      ]);
      setData({ summary, timeseries, models, sessions, rateLimits, ...(news ? { news } : {}) });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Usage data is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [provider, range, bucket]);

  useEffect(() => {
    if (!active) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [active, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await apiFetch('/api/usage/refresh', { method: 'POST' });
    } finally {
      setRefreshing(false);
    }
    await load();
  }, [load]);

  return { data, error, loading, refreshing, refresh };
}
