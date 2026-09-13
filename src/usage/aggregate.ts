// Read-side queries behind /api/usage/*. SQL groups tokens per
// (provider, model, speed, bucket); pricing is applied here per group, since
// the price table lives in code/config rather than the database.
import type { UsageAggregateRow, UsageGroupBy, UsageRepository } from '../store/usage.js';
import { costOf, resolvePrice, type PricingTable } from './pricing.js';
import type {
  TokenTotals, UsageBucket, UsageModelRow, UsagePeriod, UsagePeriodSummary, UsageProvider, UsageProviderFilter,
  UsageRange, UsageSessionRow, UsageSummary, UsageTimeseriesPoint,
} from './types.js';

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    costUsd: 0, inputCostUsd: 0, outputCostUsd: 0, unpricedTokens: 0, events: 0,
  };
}

function addRow(totals: TokenTotals, row: UsageAggregateRow, pricing: PricingTable): boolean {
  const cacheWrites = row.cacheWriteTokens + row.cacheWrite1hTokens;
  const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + cacheWrites;
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.cacheReadTokens += row.cacheReadTokens;
  totals.cacheWriteTokens += cacheWrites;
  totals.totalTokens += tokens;
  totals.events += row.events;
  const price = resolvePrice(row.model, pricing);
  if (!price) {
    totals.unpricedTokens += tokens;
    return false;
  }
  const cost = costOf(row, price);
  totals.inputCostUsd += cost.inputCostUsd;
  totals.outputCostUsd += cost.outputCostUsd;
  totals.costUsd += cost.inputCostUsd + cost.outputCostUsd;
  return true;
}

// --- local calendar boundaries ----------------------------------------------

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function periodStart(period: UsagePeriod, now: Date): Date {
  const day = startOfDay(now);
  switch (period) {
    case 'today': return day;
    case 'week': {
      const mondayOffset = (day.getDay() + 6) % 7;
      return new Date(day.getFullYear(), day.getMonth(), day.getDate() - mondayOffset);
    }
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'year': return new Date(now.getFullYear(), 0, 1);
  }
}

function previousPeriodStart(period: UsagePeriod, start: Date): Date {
  switch (period) {
    case 'today': return new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    case 'week': return new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    case 'month': return new Date(start.getFullYear(), start.getMonth() - 1, 1);
    case 'year': return new Date(start.getFullYear() - 1, 0, 1);
  }
}

export function rangeStart(range: UsageRange, now: Date): Date | undefined {
  const day = startOfDay(now);
  switch (range) {
    case '7d': return new Date(day.getFullYear(), day.getMonth(), day.getDate() - 6);
    case '30d': return new Date(day.getFullYear(), day.getMonth(), day.getDate() - 29);
    case '90d': return new Date(day.getFullYear(), day.getMonth(), day.getDate() - 89);
    case '12mo': return new Date(day.getFullYear(), day.getMonth() - 11, 1);
    case 'all': return undefined;
  }
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function bucketStart(bucket: UsageBucket, date: Date): Date {
  if (bucket === 'day') return startOfDay(date);
  if (bucket === 'week') return periodStart('week', date);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function nextBucket(bucket: UsageBucket, date: Date): Date {
  if (bucket === 'day') return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  if (bucket === 'week') return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

// --- queries -----------------------------------------------------------------

export interface UsageQueriesOptions {
  repository: UsageRepository;
  getPricing: () => PricingTable;
  now?: () => Date;
  status?: () => { indexedAt?: string; indexing: boolean };
}

export class UsageQueries {
  constructor(private readonly options: UsageQueriesOptions) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  private rows(groupBy: UsageGroupBy, from?: Date, to?: Date, provider: UsageProviderFilter = 'all'): UsageAggregateRow[] {
    return this.options.repository.aggregate({
      groupBy, provider, ...(from ? { from: from.toISOString() } : {}), ...(to ? { to: to.toISOString() } : {}),
    });
  }

  private totals(from: Date | undefined, to: Date | undefined, provider: UsageProviderFilter): TokenTotals {
    const totals = emptyTotals();
    const pricing = this.options.getPricing();
    for (const row of this.rows('none', from, to, provider)) addRow(totals, row, pricing);
    return totals;
  }

  summary(provider: UsageProviderFilter = 'all'): UsageSummary {
    const now = this.now();
    const periods: UsagePeriodSummary[] = (['today', 'week', 'month', 'year'] as const).map((period) => {
      const start = periodStart(period, now);
      const previousStart = previousPeriodStart(period, start);
      // Compare like with like: the previous period only up to the same elapsed point.
      const elapsed = now.getTime() - start.getTime();
      const previousEnd = new Date(Math.min(start.getTime(), previousStart.getTime() + elapsed));
      return {
        period,
        current: this.totals(start, undefined, provider),
        previous: this.totals(previousStart, previousEnd, provider),
      };
    });
    const models = this.models('30d', provider);
    const top = models[0];
    const status = this.options.status?.() ?? { indexing: false };
    return {
      periods,
      allTime: this.totals(undefined, undefined, provider),
      ...(top ? { topModel: { model: top.model, provider: top.provider, totalTokens: top.totalTokens } } : {}),
      ...(status.indexedAt ? { indexedAt: status.indexedAt } : {}),
      indexing: status.indexing,
    };
  }

  timeseries(bucket: UsageBucket, range: UsageRange, provider: UsageProviderFilter = 'all'): UsageTimeseriesPoint[] {
    const now = this.now();
    const pricing = this.options.getPricing();
    const rows = this.rows(bucket, rangeStart(range, now), undefined, provider);
    const points = new Map<string, UsageTimeseriesPoint>();
    const point = (key: string) => {
      let existing = points.get(key);
      if (!existing) {
        existing = { bucket: key, claude: emptyTotals(), codex: emptyTotals() };
        points.set(key, existing);
      }
      return existing;
    };
    for (const row of rows) addRow(point(row.group)[row.provider], row, pricing);

    // Fill empty buckets so gaps read as zero rather than disappearing.
    const keys = [...points.keys()].sort();
    const firstKey = keys[0];
    const start = rangeStart(range, now) ?? (firstKey ? new Date(`${firstKey}T00:00:00`) : undefined);
    if (start) {
      const end = bucketStart(bucket, now);
      for (let cursor = bucketStart(bucket, start); cursor <= end; cursor = nextBucket(bucket, cursor)) point(localDateKey(cursor));
    }
    return [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  models(range: UsageRange, provider: UsageProviderFilter = 'all'): UsageModelRow[] {
    const pricing = this.options.getPricing();
    const byModel = new Map<string, UsageModelRow>();
    for (const row of this.rows('none', rangeStart(range, this.now()), undefined, provider)) {
      const key = `${row.provider}:${row.model}`;
      let entry = byModel.get(key);
      if (!entry) {
        entry = { ...emptyTotals(), model: row.model, provider: row.provider, share: 0, lastUsedAt: row.lastAt, priced: true };
        byModel.set(key, entry);
      }
      entry.priced = addRow(entry, row, pricing) && entry.priced;
      if (row.lastAt > entry.lastUsedAt) entry.lastUsedAt = row.lastAt;
    }
    const models = [...byModel.values()];
    const total = models.reduce((sum, model) => sum + model.totalTokens, 0);
    for (const model of models) model.share = total > 0 ? model.totalTokens / total : 0;
    return models.sort((a, b) => b.totalTokens - a.totalTokens);
  }

  sessions(range: UsageRange, provider: UsageProviderFilter = 'all', limit = 100): UsageSessionRow[] {
    const pricing = this.options.getPricing();
    const bySession = new Map<string, UsageSessionRow>();
    for (const row of this.rows('session', rangeStart(range, this.now()), undefined, provider)) {
      const key = `${row.provider}:${row.group}`;
      let entry = bySession.get(key);
      if (!entry) {
        entry = {
          ...emptyTotals(), provider: row.provider as UsageProvider, sessionId: row.group, models: [],
          startedAt: row.firstAt, lastActivityAt: row.lastAt, ...(row.cwd ? { cwd: row.cwd } : {}),
        };
        bySession.set(key, entry);
      }
      addRow(entry, row, pricing);
      if (!entry.models.includes(row.model)) entry.models.push(row.model);
      if (row.firstAt < entry.startedAt) entry.startedAt = row.firstAt;
      if (row.lastAt > entry.lastActivityAt) entry.lastActivityAt = row.lastAt;
      if (!entry.cwd && row.cwd) entry.cwd = row.cwd;
    }
    return [...bySession.values()]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .slice(0, limit);
  }
}
