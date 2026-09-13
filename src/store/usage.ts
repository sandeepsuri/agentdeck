// Usage persistence: scan cursors, normalized usage events, the latest
// plan-limit snapshot, and cached model news. Exposed as Store.usage so the
// "no SQL outside src/store" rule holds for the usage module too.
import type { Database } from 'better-sqlite3';
import type { CodexFileState } from '../usage/parse.js';
import type {
  ModelNewsItem, RateLimitSnapshot, UsageEvent, UsageProvider, UsageProviderFilter,
} from '../usage/types.js';

export interface UsageFileCursor extends CodexFileState {
  path: string;
  provider: UsageProvider;
  size: number;
  mtimeMs: number;
  offset: number;
}

interface FileRow {
  path: string; provider: string; size: number; mtime_ms: number; offset: number;
  codex_session_id: string | null; codex_cwd: string | null; codex_model: string | null; codex_last_total: number | null;
}

/** Token sums for one (provider, model, speed[, group]) cell — the unit pricing is applied to. */
export interface UsageAggregateRow {
  provider: UsageProvider;
  model: string;
  speed: string | null;
  group: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  events: number;
  firstAt: string;
  lastAt: string;
  cwd: string | null;
}

export type UsageGroupBy = 'none' | 'day' | 'week' | 'month' | 'session';

export interface UsageAggregateQuery {
  from?: string;
  to?: string;
  provider?: UsageProviderFilter;
  groupBy: UsageGroupBy;
}

// Buckets use SQLite's 'localtime', i.e. the server process's time zone —
// the same machine whose logs are being read.
const GROUP_EXPRESSIONS: Record<UsageGroupBy, string> = {
  none: "''",
  day: "date(occurred_at, 'localtime')",
  // 'weekday 0' moves forward to Sunday (or stays), -6 days lands on that week's Monday.
  week: "date(occurred_at, 'localtime', 'weekday 0', '-6 days')",
  month: "strftime('%Y-%m-01', occurred_at, 'localtime')",
  session: 'session_id',
};

export class UsageRepository {
  constructor(private readonly db: Database) {}

  listFileCursors(): Map<string, UsageFileCursor> {
    const rows = this.db.prepare('SELECT * FROM usage_files').all() as FileRow[];
    return new Map(rows.map((row) => [row.path, {
      path: row.path,
      provider: row.provider as UsageProvider,
      size: row.size,
      mtimeMs: row.mtime_ms,
      offset: row.offset,
      ...(row.codex_session_id !== null ? { sessionId: row.codex_session_id } : {}),
      ...(row.codex_cwd !== null ? { cwd: row.codex_cwd } : {}),
      ...(row.codex_model !== null ? { model: row.codex_model } : {}),
      ...(row.codex_last_total !== null ? { lastTotal: row.codex_last_total } : {}),
    }]));
  }

  /** Persists a file's new cursor together with the events parsed from it, atomically. */
  commitFileScan(cursor: UsageFileCursor, events: readonly UsageEvent[], rateLimits?: RateLimitSnapshot): void {
    const upsertFile = this.db.prepare(
      `INSERT INTO usage_files (path, provider, size, mtime_ms, offset, codex_session_id, codex_cwd, codex_model, codex_last_total)
       VALUES (@path, @provider, @size, @mtimeMs, @offset, @sessionId, @cwd, @model, @lastTotal)
       ON CONFLICT(path) DO UPDATE SET provider=excluded.provider, size=excluded.size, mtime_ms=excluded.mtime_ms,
         offset=excluded.offset, codex_session_id=excluded.codex_session_id, codex_cwd=excluded.codex_cwd,
         codex_model=excluded.codex_model, codex_last_total=excluded.codex_last_total`,
    );
    // A Claude message's lines repeat its usage as streaming progresses, so
    // keep the largest value seen for each field rather than the first.
    const upsertEvent = this.db.prepare(
      `INSERT INTO usage_events (provider, event_key, session_id, model, cwd, occurred_at, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, speed)
       VALUES (@provider, @eventKey, @sessionId, @model, @cwd, @occurredAt, @inputTokens, @outputTokens,
         @cacheReadTokens, @cacheWriteTokens, @cacheWrite1hTokens, @reasoningTokens, @speed)
       ON CONFLICT(provider, event_key) DO UPDATE SET
         input_tokens=max(input_tokens, excluded.input_tokens),
         output_tokens=max(output_tokens, excluded.output_tokens),
         cache_read_tokens=max(cache_read_tokens, excluded.cache_read_tokens),
         cache_write_tokens=max(cache_write_tokens, excluded.cache_write_tokens),
         cache_write_1h_tokens=max(cache_write_1h_tokens, excluded.cache_write_1h_tokens),
         reasoning_tokens=max(reasoning_tokens, excluded.reasoning_tokens)`,
    );
    const upsertLimits = this.db.prepare(
      `INSERT INTO usage_rate_limits (provider, plan_type, primary_json, secondary_json, observed_at)
       VALUES (@provider, @planType, @primary, @secondary, @observedAt)
       ON CONFLICT(provider) DO UPDATE SET plan_type=excluded.plan_type, primary_json=excluded.primary_json,
         secondary_json=excluded.secondary_json, observed_at=excluded.observed_at
       WHERE excluded.observed_at >= usage_rate_limits.observed_at`,
    );
    const backfillModel = this.db.prepare(
      "UPDATE usage_events SET model = @model WHERE provider = 'codex' AND session_id = @sessionId AND model = 'unknown'",
    );
    this.db.transaction(() => {
      for (const event of events) {
        upsertEvent.run({ ...event, cwd: event.cwd ?? null, speed: event.speed ?? null });
      }
      if (rateLimits) {
        upsertLimits.run({
          provider: rateLimits.provider,
          planType: rateLimits.planType ?? null,
          primary: rateLimits.primary ? JSON.stringify(rateLimits.primary) : null,
          secondary: rateLimits.secondary ? JSON.stringify(rateLimits.secondary) : null,
          observedAt: rateLimits.observedAt,
        });
      }
      // A Codex turn logged before any turn_context in an earlier scan was
      // stored as 'unknown'; once the file names its model, attribute it.
      if (cursor.provider === 'codex' && cursor.sessionId && cursor.model) {
        backfillModel.run({ sessionId: cursor.sessionId, model: cursor.model });
      }
      upsertFile.run({
        path: cursor.path, provider: cursor.provider, size: cursor.size, mtimeMs: Math.floor(cursor.mtimeMs), offset: cursor.offset,
        sessionId: cursor.sessionId ?? null, cwd: cursor.cwd ?? null, model: cursor.model ?? null, lastTotal: cursor.lastTotal ?? null,
      });
    })();
  }

  aggregate(query: UsageAggregateQuery): UsageAggregateRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (query.from) { where.push('occurred_at >= @from'); params.from = query.from; }
    if (query.to) { where.push('occurred_at < @to'); params.to = query.to; }
    if (query.provider && query.provider !== 'all') { where.push('provider = @provider'); params.provider = query.provider; }
    const group = GROUP_EXPRESSIONS[query.groupBy];
    const sql = `SELECT provider, model, speed, ${group} AS grp,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
        SUM(cache_write_tokens) AS cache_write, SUM(cache_write_1h_tokens) AS cache_write_1h,
        COUNT(*) AS events, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, MAX(cwd) AS cwd
      FROM usage_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY provider, model, speed, grp`;
    const rows = this.db.prepare(sql).all(params) as {
      provider: string; model: string; speed: string | null; grp: string; input: number; output: number;
      cache_read: number; cache_write: number; cache_write_1h: number; events: number; first_at: string; last_at: string; cwd: string | null;
    }[];
    return rows.map((row) => ({
      provider: row.provider as UsageProvider,
      model: row.model,
      speed: row.speed,
      group: row.grp,
      inputTokens: row.input,
      outputTokens: row.output,
      cacheReadTokens: row.cache_read,
      cacheWriteTokens: row.cache_write,
      cacheWrite1hTokens: row.cache_write_1h,
      events: row.events,
      firstAt: row.first_at,
      lastAt: row.last_at,
      cwd: row.cwd,
    }));
  }

  getRateLimits(): RateLimitSnapshot[] {
    const rows = this.db.prepare('SELECT * FROM usage_rate_limits ORDER BY provider').all() as {
      provider: string; plan_type: string | null; primary_json: string | null; secondary_json: string | null; observed_at: string;
    }[];
    return rows.map((row) => ({
      provider: row.provider as UsageProvider,
      ...(row.plan_type ? { planType: row.plan_type } : {}),
      ...(row.primary_json ? { primary: JSON.parse(row.primary_json) } : {}),
      ...(row.secondary_json ? { secondary: JSON.parse(row.secondary_json) } : {}),
      observedAt: row.observed_at,
    }));
  }

  /** Every model seen in local usage, with when it was first used. */
  modelFirstUse(): { provider: UsageProvider; model: string; firstAt: string }[] {
    return this.db.prepare(
      'SELECT provider, model, MIN(occurred_at) AS firstAt FROM usage_events GROUP BY provider, model',
    ).all() as { provider: UsageProvider; model: string; firstAt: string }[];
  }

  /** Inserts new items and refreshes the text of known ones; ids are stable content hashes. */
  upsertNews(items: readonly ModelNewsItem[]): void {
    const statement = this.db.prepare(
      `INSERT INTO model_news (id, provider, kind, title, detail, url, published_at, fetched_at)
       VALUES (@id, @provider, @kind, @title, @detail, @url, @publishedAt, @fetchedAt)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, detail=excluded.detail, url=excluded.url`,
    );
    this.db.transaction(() => {
      for (const item of items) statement.run({ ...item, detail: item.detail ?? null, url: item.url ?? null });
    })();
  }

  listNews(limit: number): ModelNewsItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM model_news ORDER BY published_at DESC, fetched_at DESC LIMIT ?',
    ).all(limit) as {
      id: string; provider: string; kind: string; title: string; detail: string | null; url: string | null; published_at: string; fetched_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider as ModelNewsItem['provider'],
      kind: row.kind as ModelNewsItem['kind'],
      title: row.title,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.url ? { url: row.url } : {}),
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
    }));
  }

  hasNews(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM model_news WHERE id = ?').get(id) !== undefined;
  }
}
