// /api/usage/*: local Claude Code / Codex token usage and the model news
// feed. Admin/local only — none of these paths are in app.ts's remote or
// collaborator allowlists, so a remote connection is refused before reaching
// a handler (usage reveals every repository path the machine has worked in).
import type { FastifyInstance } from 'fastify';
import type { UsageQueries } from '../usage/aggregate.js';
import type { UsageIndexer } from '../usage/indexer.js';
import type { ModelNewsService } from '../usage/news.js';
import type { UsageBucket, UsageProviderFilter, UsageRange } from '../usage/types.js';

const BUCKETS: readonly UsageBucket[] = ['day', 'week', 'month'];
const RANGES: readonly UsageRange[] = ['7d', '30d', '90d', '12mo', 'all'];
const PROVIDERS: readonly UsageProviderFilter[] = ['all', 'claude', 'codex'];
const MAX_SESSION_LIMIT = 500;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | undefined {
  if (value === undefined) return fallback;
  return allowed.includes(value as T) ? value as T : undefined;
}

export interface UsageRouteContext {
  queries: UsageQueries;
  indexer: UsageIndexer;
  news: ModelNewsService;
}

export function registerUsageRoutes(app: FastifyInstance, ctx: UsageRouteContext): void {
  app.post('/api/usage/companion', async (req, reply) => {
    const body = req.body as { sessions?: unknown } | null;
    const refs = body?.sessions;
    if (!Array.isArray(refs) || refs.length > 100 || !refs.every((ref) =>
      ref && typeof ref === 'object'
      && (ref.provider === 'claude' || ref.provider === 'codex')
      && typeof ref.sessionId === 'string' && ref.sessionId.length > 0 && ref.sessionId.length <= 256)) {
      return reply.code(400).send({ error: 'invalid sessions' });
    }
    return ctx.queries.companion(refs);
  });
  app.get('/api/usage/summary', async (req, reply) => {
    const provider = oneOf((req.query as Record<string, unknown>).provider, PROVIDERS, 'all');
    if (!provider) return reply.code(400).send({ error: 'invalid provider' });
    return ctx.queries.summary(provider);
  });

  app.get('/api/usage/timeseries', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const bucket = oneOf(query.bucket, BUCKETS, 'day');
    const range = oneOf(query.range, RANGES, '30d');
    const provider = oneOf(query.provider, PROVIDERS, 'all');
    if (!bucket || !range || !provider) return reply.code(400).send({ error: 'invalid bucket, range, or provider' });
    return ctx.queries.timeseries(bucket, range, provider);
  });

  app.get('/api/usage/models', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const range = oneOf(query.range, RANGES, '30d');
    const provider = oneOf(query.provider, PROVIDERS, 'all');
    if (!range || !provider) return reply.code(400).send({ error: 'invalid range or provider' });
    return ctx.queries.models(range, provider);
  });

  app.get('/api/usage/sessions', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const range = oneOf(query.range, RANGES, '30d');
    const provider = oneOf(query.provider, PROVIDERS, 'all');
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!range || !provider || !Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_LIMIT) {
      return reply.code(400).send({ error: 'invalid range, provider, or limit' });
    }
    return ctx.queries.sessions(range, provider, limit);
  });

  app.get('/api/usage/rate-limits', async () => ctx.indexer.rateLimits());

  app.get('/api/usage/news', async () => ctx.news.feed());

  app.post('/api/usage/refresh', async () => {
    await Promise.all([ctx.indexer.refresh(), ctx.news.refresh()]);
    return { ok: true, indexedAt: ctx.indexer.indexedAt };
  });
}
