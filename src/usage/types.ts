// Shapes shared by the usage indexer, the /api/usage/* routes, and the UI.
// Import-free so the browser bundle can use them directly.

export type UsageProvider = 'claude' | 'codex';

/** One billed model response, normalized across providers. Token fields never overlap: input excludes cache reads/writes. */
export interface UsageEvent {
  provider: UsageProvider;
  /** Claude message.id, or `<codex session>:<cumulative total>` — the dedupe key. */
  eventKey: string;
  sessionId: string;
  model: string;
  cwd?: string;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute (Claude) or unspecified cache writes. */
  cacheWriteTokens: number;
  /** Claude 1-hour cache writes, priced higher than 5-minute writes. */
  cacheWrite1hTokens: number;
  /** Informational: already included in outputTokens. */
  reasoningTokens: number;
  speed?: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
}

export interface RateLimitSnapshot {
  provider: UsageProvider;
  planType?: string;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  observedAt: string;
}

export type ModelNewsKind = 'launch' | 'update' | 'deprecation' | 'retirement' | 'first-seen';

export interface ModelNewsItem {
  id: string;
  provider: 'anthropic' | 'openai' | 'local';
  kind: ModelNewsKind;
  title: string;
  detail?: string;
  url?: string;
  publishedAt: string;
  fetchedAt: string;
  /** Models from your own usage that this item mentions — computed when the feed is read. */
  affectsModels?: string[];
}

export interface ModelNewsFeed {
  items: ModelNewsItem[];
  lastFetchedAt?: string;
  lastError?: string;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Estimated API cost in USD; tokens from unpriced models are excluded and counted in unpricedTokens. */
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  unpricedTokens: number;
  events: number;
}

export type UsagePeriod = 'today' | 'week' | 'month' | 'year';

export interface UsagePeriodSummary {
  period: UsagePeriod;
  current: TokenTotals;
  previous: TokenTotals;
}

export interface UsageSummary {
  periods: UsagePeriodSummary[];
  allTime: TokenTotals;
  topModel?: { model: string; provider: UsageProvider; totalTokens: number };
  indexedAt?: string;
  indexing: boolean;
}

export type UsageBucket = 'day' | 'week' | 'month';
export type UsageRange = '7d' | '30d' | '90d' | '12mo' | 'all';
export type UsageProviderFilter = UsageProvider | 'all';

export interface UsageTimeseriesPoint {
  /** Local-time bucket start, YYYY-MM-DD. */
  bucket: string;
  claude: TokenTotals;
  codex: TokenTotals;
}

export interface UsageModelRow extends TokenTotals {
  model: string;
  provider: UsageProvider;
  share: number;
  lastUsedAt: string;
  priced: boolean;
}

export interface UsageSessionRow extends TokenTotals {
  provider: UsageProvider;
  sessionId: string;
  cwd?: string;
  models: string[];
  startedAt: string;
  lastActivityAt: string;
}
