import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { DurableWorkEngine } from '../work-engine/engine.js';
import type { WorkSpec } from '../work-engine/types.js';
import { registerWorkRoutes } from './work-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
const stores: Store[] = [];

function makeApp() {
  const app = Fastify();
  const store = new Store(':memory:');
  store.upsertRepo({ id: '/repos/example', name: 'example', path: '/repos/example' });
  registerWorkRoutes(app, new DurableWorkEngine(store));
  apps.push(app);
  stores.push(store);
  return app;
}

function submittedIntent(): WorkSpec {
  return {
    objective: 'Keep a run across restart',
    acceptanceCriteria: ['The run keeps its identity', 'The intent is unchanged'],
    repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
    requestedBaseReference: 'feature/exact-request',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 900_000, maxModelTurns: 25 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'local-commit',
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const store of stores.splice(0)) store.close();
});

describe('work routes', () => {
  it('submits and retrieves a queued run through the Work Engine', async () => {
    const app = makeApp();
    const submitted = submittedIntent();

    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: submitted,
    });

    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run).toMatchObject({ status: 'queued', spec: submitted });

    const reopened = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toEqual(run);

    const listed = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listed.json()).toEqual([run]);
  });

  it('reports invalid intent and unknown run identities precisely', async () => {
    const app = makeApp();
    const invalid = submittedIntent();
    invalid.objective = '   ';

    const rejected = await app.inject({ method: 'POST', url: '/api/runs', payload: invalid });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: 'objective must be a non-empty string' });

    const missing = await app.inject({ method: 'GET', url: '/api/runs/unknown' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no such run' });
  });
});
