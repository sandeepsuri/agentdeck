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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Session } from '../types.js';
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
// A real directory, not a fixture string: POST /api/sessions/:id/send writes
// the agent bus and inbox under the Repository, so the send path can only be
// exercised end to end against somewhere writable.
const REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-collab-repo-'));
const UNGRANTED_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-collab-secret-'));

/** The agents on this machine, as the stub SessionManager reports them. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ext-4711-1', origin: 'external', agent: 'claude', name: 'Claude on auth',
    repoId: REPO_PATH, cwd: `${REPO_PATH}/packages/api`, branch: 'feat/auth', pid: 4711,
    startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
    status: 'working', statusSource: 'hook', tty: 'ttys004', terminalApp: 'VSCode',
    agentSessionId: 'claude:0e655530-853a-4693',
    launchSpec: { agent: 'claude', cwd: REPO_PATH, initialPrompt: 'the admin’s private prompt' },
    ...overrides,
  };
}

const profile: Profile = {
  id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
  budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
};

let store: Store;
afterEach(() => { store.close(); });

/** Exactly index.ts's wiring (see startServer): the same classify(), the same two resolvers. */
function setUp() {
  let sessions: Session[] = [];
  store = new Store(':memory:');
  store.upsertRepo({ id: REPO_PATH, name: 'example', path: REPO_PATH });
  store.upsertRepo({ id: UNGRANTED_REPO_PATH, name: 'secret', path: UNGRANTED_REPO_PATH });
  store.createProfile(profile);
  const collaborators = new CollaboratorService(store);
  const workEngine = new DurableWorkEngine(store, path.join('/tmp', 'agentdeck-integration-runs'));
  const app = buildApp({
    // An unscannable projectsDir forces GET /api/repos onto the store's own
    // listRepos() fallback — otherwise scanRepos() walks this real machine
    // and never sees the fixture Repositories at all (same reason
    // app.test.ts's grant-filtering case does this).
    config: { ...defaultConfig(), projectsDir: '/nonexistent/agentdeck-integration-projects' },
    // A stub SessionManager rather than a real one: what this suite is about
    // is whether the grant reaches the session routes, not whether a PTY can
    // be spawned. `sessions` is settable per test through the returned handle.
    manager: {
      listSessions: () => sessions,
      getSession: (id: string) => sessions.find((item) => item.id === id),
      isLive: () => true,
      write: () => undefined,
    } as unknown as RouteContext['manager'],
    store,
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
  return { app, token, workEngine, setSessions: (next: Session[]) => { sessions = next; } };
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
      repository: { id: UNGRANTED_REPO_PATH, name: 'secret', path: UNGRANTED_REPO_PATH },
      requestedBaseReference: 'main', runtimePreference: ['codex'], budget: {},
      verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree',
    });

    const listed = await app.inject({ method: 'GET', url: '/api/runs', headers: asAlice(token) });
    expect(listed.json()).toEqual([]);

    const direct = await app.inject({ method: 'GET', url: `/api/runs/${adminRun.id}`, headers: asAlice(token) });
    expect(direct.statusCode).toBe(404);

    const submitted = await app.inject({
      method: 'POST', url: '/api/runs', headers: asAlice(token),
      payload: JSON.stringify({ ...JSON.parse(requestBody()), repository: { id: UNGRANTED_REPO_PATH, name: 'secret', path: '' } }),
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

  it('sees the agents running in a granted Repository, narrowed — never how this machine is laid out', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([session({ worktreePath: `${REPO_PATH}/.worktrees/run-1` })]);

    const listed = await app.inject({ method: 'GET', url: '/api/sessions', headers: asAlice(token) });

    expect(listed.statusCode).toBe(200);
    const [agent] = listed.json() as { id: string; name: string; repoId: string }[];
    expect(agent).toMatchObject({ id: 'ext-4711-1', name: 'Claude on auth', repoId: REPO_PATH });
    for (const field of ['cwd', 'worktreePath', 'pid', 'tty', 'terminalApp', 'launchSpec', 'agentSessionId']) {
      expect(agent, field).not.toHaveProperty(field);
    }
    expect(listed.body).not.toContain('private prompt');
    await app.close();
  });

  // The whole point of lifting the remote origin filter for a grant-carrying
  // device: an assigned Repository's live agent is usually one the admin
  // started in their own terminal, and managed-only would show an empty list.
  it('sees an external agent, not only AgentDeck-launched ones', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([session({ origin: 'external' }), session({ id: 'managed-1', origin: 'managed' })]);

    const listed = await app.inject({ method: 'GET', url: '/api/sessions', headers: asAlice(token) });

    expect((listed.json() as { id: string }[]).map((item) => item.id)).toEqual(['ext-4711-1', 'managed-1']);
    await app.close();
  });

  it('is never shown an agent in a Repository it was not granted, and cannot reach one it names directly', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([
      session({ id: 'secret-1', name: 'Claude somewhere else', repoId: UNGRANTED_REPO_PATH }),
      // A Session with no Repository at all cannot be scoped by a grant, so it
      // is not reachable either -- absence here is the deliberate behaviour.
      session({ id: 'rootless-1', repoId: undefined }),
    ]);

    const listed = await app.inject({ method: 'GET', url: '/api/sessions', headers: asAlice(token) });
    expect(listed.json()).toEqual([]);

    for (const url of ['/api/sessions/secret-1/messages', '/api/sessions/rootless-1/capabilities']) {
      const direct = await app.inject({ method: 'GET', url, headers: asAlice(token) });
      // 404, never 403: the difference would tell a collaborator that a
      // Repository they were not granted exists.
      expect(direct.statusCode, url).toBe(404);
      expect(direct.json(), url).toEqual({ error: 'no such session' });
    }

    const send = await app.inject({
      method: 'POST', url: '/api/sessions/secret-1/send', headers: asAlice(token), payload: JSON.stringify({ text: 'hello' }),
    });
    expect(send.statusCode).toBe(404);
    await app.close();
  });

  it('reads a granted agent’s conversation as turns, with this Repository’s paths rewritten out', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([session()]);
    await fs.promises.mkdir(path.join(REPO_PATH, '.agents'), { recursive: true });
    await fs.promises.writeFile(path.join(REPO_PATH, '.agents', 'bus.jsonl'), [
      JSON.stringify({
        ts: '2026-09-01T00:01:00.000Z', agent: 'dashboard:ext-4711-1', repo: REPO_PATH,
        event: 'message', message: 'Any progress?', sessionId: 'ext-4711-1',
      }),
      JSON.stringify({
        ts: '2026-09-01T00:02:00.000Z', agent: 'claude:0e655530-853a-4693', repo: REPO_PATH,
        event: 'message', message: `Patched ${REPO_PATH}/src/auth.ts`, sessionId: 'ext-4711-1',
      }),
    ].join('\n') + '\n');

    const read = await app.inject({ method: 'GET', url: '/api/sessions/ext-4711-1/messages', headers: asAlice(token) });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual([
      { ts: '2026-09-01T00:01:00.000Z', author: 'human', event: 'message', text: 'Any progress?' },
      { ts: '2026-09-01T00:02:00.000Z', author: 'agent', event: 'message', text: 'Patched ./src/auth.ts' },
    ]);
    expect(read.body).not.toContain(REPO_PATH);
    await app.close();
  });

  it('messages a granted external agent through the hook inbox, never by scripting the operator’s terminal', async () => {
    const { app, token, setSessions } = setUp();
    // terminalApp is set, which is exactly the case that would otherwise take
    // the AppleScript branch and type into the admin's own VSCode window.
    setSessions([session({ terminalApp: 'VSCode' })]);

    const capabilities = await app.inject({
      method: 'GET', url: '/api/sessions/ext-4711-1/capabilities', headers: asAlice(token),
    });
    expect(capabilities.json()).toEqual({ send: 'queued' });

    const sent = await app.inject({
      method: 'POST', url: '/api/sessions/ext-4711-1/send', headers: asAlice(token),
      payload: JSON.stringify({ text: 'Any progress?' }),
    });

    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ delivered: 'queued' });
    const inbox = await fs.promises.readFile(path.join(REPO_PATH, '.agents', 'inbox.jsonl'), 'utf8');
    expect(inbox).toContain('Any progress?');
    expect(inbox).toContain('claude:0e655530-853a-4693');
    await app.close();
  });

  it('is refused a raw control byte in the composer — a grant is not the raw-write capability', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    const sent = await app.inject({
      method: 'POST', url: '/api/sessions/ext-4711-1/send', headers: asAlice(token),
      payload: JSON.stringify({ text: 'stop\u0003' }),
    });

    expect(sent.statusCode).toBe(400);
    expect(sent.json()).toMatchObject({ error: 'raw control characters are not permitted from this connection' });
    await app.close();
  });

  it('is told why, rather than silently failing, when a granted agent cannot be messaged', async () => {
    const { app, token, setSessions } = setUp();
    setSessions([session({ status: 'exited' })]);

    const capabilities = await app.inject({
      method: 'GET', url: '/api/sessions/ext-4711-1/capabilities', headers: asAlice(token),
    });
    expect(capabilities.json()).toMatchObject({ send: 'unavailable' });

    const sent = await app.inject({
      method: 'POST', url: '/api/sessions/ext-4711-1/send', headers: asAlice(token), payload: JSON.stringify({ text: 'hello' }),
    });
    expect(sent.statusCode).toBe(400);
    expect((sent.json() as { error: string }).error).toContain('read-only');
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
