// Ticket 12: input validation and shape coverage for the Profiles REST
// surface (registerProfileRoutes) in isolation. The
// authentication/authorization side — admin-only POST, grant-filtered GET
// — is covered end to end in app.test.ts, which exercises the full
// onRequest hook these routes sit behind.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { registerProfileRoutes } from './profile-routes.js';

let app: ReturnType<typeof Fastify>;
let store: Store;

function makeApp(resolveGrantedProfileIds?: Parameters<typeof registerProfileRoutes>[2]) {
  store = new Store(':memory:');
  app = Fastify();
  registerProfileRoutes(app, store, resolveGrantedProfileIds);
  return { app, store };
}

afterEach(async () => {
  await app.close();
  store.close();
});

const validProfile = {
  name: 'Standard Codex run',
  runtimePreference: ['codex'],
  budget: { maxWallClockMs: 900_000, maxModelTurns: 25 },
  verificationIntent: { required: true, commands: ['npm test'] },
  requestedDeliveryResult: 'local-commit',
};

describe('POST /api/profiles', () => {
  it('creates a Profile and returns it with a generated id', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' }, payload: validProfile,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; name: string; createdAt: string };
    expect(body.name).toBe('Standard Codex run');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.createdAt).toEqual(expect.any(String));
  });

  it('400s a missing name', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
      payload: { ...validProfile, name: undefined },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'name is required' });
  });

  it('400s an empty or invalid runtimePreference', async () => {
    makeApp();
    for (const runtimePreference of [[], ['not-a-runtime'], 'codex']) {
      const response = await app.inject({
        method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
        payload: { ...validProfile, runtimePreference },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('400s an unknown budget key rather than silently persisting it inside an otherwise-immutable Profile', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
      payload: { ...validProfile, budget: { maxWallClock: 900_000 } }, // missing the trailing "Ms"
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s a budget with a non-positive or non-numeric limit', async () => {
    makeApp();
    for (const budget of [{ maxWallClockMs: -1 }, { maxWallClockMs: 'a lot' }]) {
      const response = await app.inject({
        method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
        payload: { ...validProfile, budget },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('400s verificationIntent.required true with no commands', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
      payload: { ...validProfile, verificationIntent: { required: true, commands: [] } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s an invalid requestedDeliveryResult', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' },
      payload: { ...validProfile, requestedDeliveryResult: 'deploy-to-prod' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/profiles', () => {
  it('lists every Profile when no grant resolver is configured (local admin)', async () => {
    makeApp();
    await app.inject({ method: 'POST', url: '/api/profiles', headers: { 'content-type': 'application/json' }, payload: validProfile });
    const response = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBe(1);
  });

  it('filters to the resolved grant set when a resolver is configured', async () => {
    const { store: s } = makeApp(() => ['profile-1']);
    s.createProfile({
      id: 'profile-1', name: 'Granted', runtimePreference: ['codex'], budget: { maxWallClockMs: 1 },
      verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree', createdAt: '2026-01-01T00:00:00.000Z',
    });
    s.createProfile({
      id: 'profile-2', name: 'Ungranted', runtimePreference: ['codex'], budget: { maxWallClockMs: 1 },
      verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree', createdAt: '2026-01-01T00:00:00.000Z',
    });
    const response = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect((response.json() as { id: string }[]).map((p) => p.id)).toEqual(['profile-1']);
  });
});
