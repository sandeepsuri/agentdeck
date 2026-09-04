// The seam nothing else covers: a REAL collaborator device credential
// travelling the whole path — classify() resolves the device, app.ts's
// allowlist opens the route, work-routes.ts resolves the grants, and
// collaborator-run-view.ts narrows what comes back.
//
// The other three suites each cover one link and stub the rest:
// app.test.ts proves the gate opens (404 on a bare app with no work routes),
// work-routes.test.ts stubs resolveGrantedRepositoryIds, and
// collaborator-run-view.test.ts is a pure projection unit. A regression in
// the WIRING between them — index.ts's resolveGrantedRepositoryIds/
// resolveActor — would pass all three and still ship a Run's absolute paths
// to a phone. So this builds the app the way index.ts does, and asks a real
// device token for its Runs.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { Store } from '../store/index.js';
import { DurableWorkEngine } from '../work-engine/engine.js';
import type { Profile, WorkSpec } from '../work-engine/types.js';
import { buildApp } from './app.js';
import { classify, toRunActor, TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';
import { registerWorkRoutes } from './work-routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const REPO_PATH = '/repos/example';

const profile: Profile = {
  id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
  budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
};

let store: Store;
afterEach(() => { store.close(); });

/** Exactly index.ts's wiring (see startServer): the same classify(), the same two resolvers. */
function setUp() {
  store = new Store(':memory:');
  store.upsertRepo({ id: REPO_PATH, name: 'example', path: REPO_PATH });
  store.upsertRepo({ id: '/repos/secret', name: 'secret', path: '/repos/secret' });
  store.createProfile(profile);
  const collaborators = new CollaboratorService(store);
  const workEngine = new DurableWorkEngine(store, path.join('/tmp', 'agentdeck-integration-runs'));
  const app = buildApp({
    // An unscannable projectsDir forces GET /api/repos onto the store's own
    // listRepos() fallback — otherwise scanRepos() walks this real machine
    // and never sees the fixture Repositories at all (same reason
    // app.test.ts's grant-filtering case does this).
    config: { ...defaultConfig(), projectsDir: '/nonexistent/agentdeck-integration-projects' },
    manager: {} as RouteContext['manager'], store,
    remoteHosts: [REMOTE_HOST], collaborators, workEngine,
  });
  const requestTrust = (req: FastifyRequest) => classify(
    { host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER] as string | undefined },
    { remoteHosts: [REMOTE_HOST], deviceLookup: collaborators.resolveDevice },
  );
  registerWorkRoutes(app, workEngine, {
    resolveGrantedRepositoryIds: (req) => requestTrust(req).device?.grantedRepositoryIds,
    resolveActor: (req) => {
      const device = requestTrust(req).device;
      return device && toRunActor(device);
    },
  });
  const { code } = collaborators.inviteCollaborator({
    displayName: 'Alice', grantedRepositoryIds: [REPO_PATH], grantedProfileIds: [profile.id],
  });
  const { token } = collaborators.exchangeInvitation(code, "Alice's phone");
  return { app, token, workEngine };
}

const asAlice = (token: string) => ({ host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' });

/** What CollaboratorWorkspace's RequestWorkComposer actually sends — no Repository path, because it was never told one. */
function requestBody(): string {
  const spec: Partial<WorkSpec> = {
    objective: 'Fix the flaky auth test',
    acceptanceCriteria: ['It passes ten times'],
    repository: { id: REPO_PATH, name: 'example', path: '' },
    requestedBaseReference: 'main',
    runtimePreference: ['codex'],
    budget: {},
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'local-commit',
    profileId: profile.id,
  };
  return JSON.stringify(spec);
}

describe('a named collaborator device, end to end', () => {
  it('requests work with no Repository path and the engine still freezes the real one', async () => {
    const { app, token, workEngine } = setUp();

    const created = await app.inject({ method: 'POST', url: '/api/runs', headers: asAlice(token), payload: requestBody() });

    expect(created.statusCode).toBe(201);
    const stored = workEngine.get((created.json() as { id: string }).id)!;
    expect(stored.spec.repository).toEqual({ id: REPO_PATH, name: 'example', path: REPO_PATH });
    expect(stored.principal.displayName).toBe('Alice');
    await app.close();
  });

  it('reads its own Runs back narrowed — no spec, no envelope, no Repository path', async () => {
    const { app, token } = setUp();
    await app.inject({ method: 'POST', url: '/api/runs', headers: asAlice(token), payload: requestBody() });

    const listed = await app.inject({ method: 'GET', url: '/api/runs', headers: asAlice(token) });

    expect(listed.statusCode).toBe(200);
    const [run] = listed.json() as { objective: string; repository: unknown; spec?: unknown }[];
    expect(run!.objective).toBe('Fix the flaky auth test');
    expect(run!.repository).toEqual({ id: REPO_PATH, name: 'example' });
    expect(run!.spec).toBeUndefined();
    // The Repository id happens to look like a path in this fixture; what
    // must not appear is the spec/envelope/preparation shape around it.
    expect(listed.body).not.toContain('capabilityEnvelope');
    expect(listed.body).not.toContain('worktreePath');
    await app.close();
  });

  it('reads one Run as a conversation, with a narrative and no raw command anywhere', async () => {
    const { app, token } = setUp();
    const runId = (await app.inject({
      method: 'POST', url: '/api/runs', headers: asAlice(token), payload: requestBody(),
    })).json<{ id: string }>().id;

    const fetched = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: asAlice(token) });

    expect(fetched.statusCode).toBe(200);
    const detail = fetched.json() as { narrative: { steps: unknown[] }; envelope?: unknown; verificationPolicy?: unknown };
    expect(detail.narrative.steps).toEqual([]);
    expect(detail.envelope).toBeUndefined();
    expect(detail.verificationPolicy).toBeUndefined();
    await app.close();
  });

  it('is refused a Repository it was never granted, and never learns a Run there exists', async () => {
    const { app, token, workEngine } = setUp();
    // A Run the admin created in the ungranted Repository.
    const adminRun = await workEngine.submit({
      objective: 'Something else entirely', acceptanceCriteria: ['done'],
      repository: { id: '/repos/secret', name: 'secret', path: '/repos/secret' },
      requestedBaseReference: 'main', runtimePreference: ['codex'], budget: {},
      verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree',
    });

    const listed = await app.inject({ method: 'GET', url: '/api/runs', headers: asAlice(token) });
    expect(listed.json()).toEqual([]);

    const direct = await app.inject({ method: 'GET', url: `/api/runs/${adminRun.id}`, headers: asAlice(token) });
    expect(direct.statusCode).toBe(404);

    const submitted = await app.inject({
      method: 'POST', url: '/api/runs', headers: asAlice(token),
      payload: JSON.stringify({ ...JSON.parse(requestBody()), repository: { id: '/repos/secret', name: 'secret', path: '' } }),
    });
    expect(submitted.statusCode).toBe(403);
    expect(submitted.json()).toMatchObject({ rule: 'repository-not-granted' });
    await app.close();
  });

  it('is still refused every admin-only Run action, whatever it can read', async () => {
    const { app, token } = setUp();
    const runId = (await app.inject({
      method: 'POST', url: '/api/runs', headers: asAlice(token), payload: requestBody(),
    })).json<{ id: string }>().id;

    for (const [method, url] of [
      ['POST', `/api/runs/${runId}/publish`],
      ['DELETE', `/api/runs/${runId}`],
      ['GET', `/api/runs/${runId}/activity`],
    ] as const) {
      const response = await app.inject({ method, url, headers: asAlice(token), payload: method === 'GET' ? undefined : '{}' });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it('sees its granted Repositories without their absolute paths', async () => {
    const { app, token } = setUp();

    const repos = await app.inject({ method: 'GET', url: '/api/repos', headers: asAlice(token) });

    expect(repos.statusCode).toBe(200);
    expect(repos.json()).toEqual([{ id: REPO_PATH, name: 'example' }]);
    expect(repos.body).not.toContain('secret');
    await app.close();
  });
});
