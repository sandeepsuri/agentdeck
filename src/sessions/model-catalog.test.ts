// ModelCatalog (ticket 12): runtime-fetched, allowlist-filtered, cached
// model list behind one interface for both providers. Never makes a real
// network call in tests — OpenAiModelSource takes an injectable fetchImpl,
// exactly like PtyBackend/Summarizer are faked elsewhere in this codebase.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeModelSource, DEFAULT_MODEL_SETTING_KEY, ModelCatalog, OpenAiModelSource, parseModelId,
} from './model-catalog.js';

describe('ClaudeModelSource', () => {
  it('always reports a small static, subscription-billed, available list', async () => {
    const source = new ClaudeModelSource();
    const models = await source.list();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.provider).toBe('claude-cli');
      expect(model.billing).toBe('subscription');
      expect(model.available).toBe(true);
      expect(model.id.startsWith('claude-cli:')).toBe(true);
    }
  });
});

describe('OpenAiModelSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a single disabled placeholder with a configure-key hint when no key is set', async () => {
    const source = new OpenAiModelSource({ getApiKey: () => undefined });
    const models = await source.list();
    expect(models).toHaveLength(1);
    expect(models[0]!.available).toBe(false);
    expect(models[0]!.provider).toBe('openai');
    expect(models[0]!.billing).toBe('api-key');
    expect(models[0]!.unavailableReason).toMatch(/api key/i);
  });

  it('never calls fetch when no key is configured', async () => {
    const fetchImpl = vi.fn();
    const source = new OpenAiModelSource({ getApiKey: () => undefined, fetchImpl });
    await source.list();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches, allowlist-filters, and marks models available when a key is configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-4o' },
        { id: 'gpt-4o-mini' },
        { id: 'text-embedding-3-small' }, // must be filtered out
        { id: 'dall-e-3' }, // must be filtered out
        { id: 'whisper-1' }, // must be filtered out
      ],
    }), { status: 200 }));
    const source = new OpenAiModelSource({ getApiKey: () => 'sk-test', fetchImpl });
    const models = await source.list();
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual(['openai:gpt-4o', 'openai:gpt-4o-mini']);
    for (const model of models) {
      expect(model.available).toBe(true);
      expect(model.provider).toBe('openai');
      expect(model.billing).toBe('api-key');
    }
  });

  it('sends the API key as a bearer token, never in the URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const source = new OpenAiModelSource({ getApiKey: () => 'sk-super-secret', fetchImpl });
    await source.list();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('sk-super-secret');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-super-secret');
  });

  it('throws when the models request fails, so the catalog can surface it per-provider', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const source = new OpenAiModelSource({ getApiKey: () => 'sk-bad', fetchImpl });
    await expect(source.list()).rejects.toThrow(/401/);
  });
});

describe('ModelCatalog', () => {
  it('merges results from every source into one list', async () => {
    const catalog = new ModelCatalog([
      { provider: 'claude-cli', list: async () => [{ id: 'claude-cli:opus', displayName: 'Opus', provider: 'claude-cli', billing: 'subscription', available: true }] },
      { provider: 'openai', list: async () => [{ id: 'openai:gpt-4o', displayName: 'gpt-4o', provider: 'openai', billing: 'api-key', available: true }] },
    ]);
    const models = await catalog.list();
    expect(models.map((m) => m.id).sort()).toEqual(['claude-cli:opus', 'openai:gpt-4o']);
  });

  it('caches: a source is not re-queried within the TTL', async () => {
    const list = vi.fn(async () => [{ id: 'claude-cli:opus', displayName: 'Opus', provider: 'claude-cli' as const, billing: 'subscription' as const, available: true }]);
    const catalog = new ModelCatalog([{ provider: 'claude-cli', list }], { ttlMs: 60_000 });
    await catalog.list();
    await catalog.list();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('re-queries once the TTL elapses', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const list = vi.fn(async () => [{ id: 'claude-cli:opus', displayName: 'Opus', provider: 'claude-cli' as const, billing: 'subscription' as const, available: true }]);
    const catalog = new ModelCatalog([{ provider: 'claude-cli', list }], { ttlMs: 1000 });
    await catalog.list();
    now = 2000;
    await catalog.list();
    expect(list).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('invalidate() forces the next list() to re-query immediately', async () => {
    const list = vi.fn(async () => [{ id: 'claude-cli:opus', displayName: 'Opus', provider: 'claude-cli' as const, billing: 'subscription' as const, available: true }]);
    const catalog = new ModelCatalog([{ provider: 'claude-cli', list }], { ttlMs: 60_000 });
    await catalog.list();
    catalog.invalidate();
    await catalog.list();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a failing source becomes a single disabled entry instead of failing the whole catalog', async () => {
    const catalog = new ModelCatalog([
      { provider: 'claude-cli', list: async () => [{ id: 'claude-cli:opus', displayName: 'Opus', provider: 'claude-cli', billing: 'subscription', available: true }] },
      { provider: 'openai', list: async () => { throw new Error('OpenAI models request failed: 401'); } },
    ]);
    const models = await catalog.list();
    expect(models).toHaveLength(2);
    const failed = models.find((m) => m.provider === 'openai')!;
    expect(failed.available).toBe(false);
    expect(failed.unavailableReason).toMatch(/401/);
  });
});

describe('parseModelId', () => {
  it('splits a provider-qualified id into provider and the remainder', () => {
    expect(parseModelId('claude-cli:opus')).toEqual({ provider: 'claude-cli', modelId: 'opus' });
    expect(parseModelId('openai:gpt-4o-mini')).toEqual({ provider: 'openai', modelId: 'gpt-4o-mini' });
  });

  it('rejects an id with no provider prefix', () => {
    expect(() => parseModelId('opus')).toThrow(/provider/);
  });

  it('rejects an unknown provider prefix', () => {
    expect(() => parseModelId('gemini:pro')).toThrow(/unknown/i);
  });
});

describe('DEFAULT_MODEL_SETTING_KEY', () => {
  it('is a stable, non-empty settings key', () => {
    expect(DEFAULT_MODEL_SETTING_KEY).toBe('defaultSummaryModel');
  });
});
