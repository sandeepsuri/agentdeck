// Ticket 12: GET /api/models (the fetched/cached/allowlisted catalog) and
// GET/PATCH /api/settings (default model + OpenAI API key). ModelCatalog
// and the config write path are faked here — real fetch/subprocess/disk
// behavior is covered in model-catalog.test.ts and config.test.ts.
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { Model } from '../sessions/model-catalog.js';
import { registerRoutes, type RouteContext } from './routes.js';

const models: Model[] = [
  { id: 'claude-cli:opus', displayName: 'Claude Opus (latest)', provider: 'claude-cli', billing: 'subscription', available: true },
  {
    id: 'openai:unconfigured', displayName: 'OpenAI (configure an API key)', provider: 'openai',
    billing: 'api-key', available: false, unavailableReason: 'Requires an OpenAI API key — add one in Settings.',
  },
];

describe('GET /api/models', () => {
  let app: ReturnType<typeof Fastify>;
  let listMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = Fastify();
    listMock = vi.fn(async () => models);
    registerRoutes(app, {
      manager: {} as RouteContext['manager'],
      config: defaultConfig(),
      modelCatalog: { list: listMock, invalidate: vi.fn() } as unknown as RouteContext['modelCatalog'],
    });
  });

  afterEach(async () => { await app.close(); });

  it('returns the catalog, including disabled entries with their hint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/models' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(models);
  });

  it('returns an empty list rather than erroring when no catalog is configured', async () => {
    app = Fastify();
    registerRoutes(app, { manager: {} as RouteContext['manager'], config: defaultConfig() });
    const response = await app.inject({ method: 'GET', url: '/api/models' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe('GET/PATCH /api/settings', () => {
  let app: ReturnType<typeof Fastify>;
  let getSetting: ReturnType<typeof vi.fn>;
  let setSetting: ReturnType<typeof vi.fn>;
  let saveConfigMock: ReturnType<typeof vi.fn>;
  let invalidateMock: ReturnType<typeof vi.fn>;
  let config: ReturnType<typeof defaultConfig>;

  beforeEach(() => {
    app = Fastify();
    config = defaultConfig();
    getSetting = vi.fn(() => undefined);
    setSetting = vi.fn();
    saveConfigMock = vi.fn();
    invalidateMock = vi.fn();
    registerRoutes(app, {
      manager: {} as RouteContext['manager'],
      config,
      store: { getSetting, setSetting } as unknown as RouteContext['store'],
      modelCatalog: { list: vi.fn(async () => []), invalidate: invalidateMock } as unknown as RouteContext['modelCatalog'],
      saveConfig: saveConfigMock,
    });
  });

  afterEach(async () => { await app.close(); });

  it('reports openaiKeyConfigured: false and no default when nothing is set', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ defaultModel: undefined, openaiKeyConfigured: false });
  });

  it('reports openaiKeyConfigured: true once a key is in config, without ever including the key', async () => {
    config.openaiApiKey = 'sk-super-secret';
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = response.body;
    expect(body).not.toContain('sk-super-secret');
    expect(response.json()).toEqual({ defaultModel: undefined, openaiKeyConfigured: true });
  });

  it('reports the stored default model', async () => {
    getSetting.mockReturnValue('claude-cli:sonnet');
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.json()).toEqual({ defaultModel: 'claude-cli:sonnet', openaiKeyConfigured: false });
  });

  it('PATCH sets the default model via store.setSetting, never via saveConfig', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { defaultModel: 'openai:gpt-4o-mini' },
    });
    expect(response.statusCode).toBe(200);
    expect(setSetting).toHaveBeenCalledWith('defaultSummaryModel', 'openai:gpt-4o-mini');
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('rejects an empty default model', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { defaultModel: '' } });
    expect(response.statusCode).toBe(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('PATCH sets the API key via saveConfig, never via store.setSetting, and never echoes it back', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { openaiApiKey: 'sk-super-secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(saveConfigMock).toHaveBeenCalledWith({ openaiApiKey: 'sk-super-secret' });
    expect(setSetting).not.toHaveBeenCalled();
    expect(config.openaiApiKey).toBe('sk-super-secret');
    expect(response.body).not.toContain('sk-super-secret');
    expect(response.json()).toEqual({ ok: true, defaultModel: undefined, openaiKeyConfigured: true });
  });

  it('PATCH invalidates the model catalog cache after the key changes', async () => {
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { openaiApiKey: 'sk-new' } });
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it('clears the API key when sent an empty string, and invalidates the catalog', async () => {
    config.openaiApiKey = 'sk-old';
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { openaiApiKey: '' } });
    expect(response.statusCode).toBe(200);
    expect(saveConfigMock).toHaveBeenCalledWith({ openaiApiKey: undefined });
    expect(config.openaiApiKey).toBeUndefined();
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ ok: true, defaultModel: undefined, openaiKeyConfigured: false });
  });

  it('rejects a non-string, non-null API key', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { openaiApiKey: 42 } });
    expect(response.statusCode).toBe(400);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a JSON object', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/settings',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify('nope'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('can set both the default model and the key in one request', async () => {
    const response = await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { defaultModel: 'claude-cli:opus', openaiApiKey: 'sk-both' },
    });
    expect(response.statusCode).toBe(200);
    expect(setSetting).toHaveBeenCalledWith('defaultSummaryModel', 'claude-cli:opus');
    expect(saveConfigMock).toHaveBeenCalledWith({ openaiApiKey: 'sk-both' });
  });
});
