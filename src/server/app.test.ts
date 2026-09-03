// Ticket 05: the REST origin/host check, the WebSocket upgrade (ws.test.ts),
// and the CSP connect-src header must all agree on which hosts are allowed
// — this exercises the REST/CSP side of that agreement, all mediated by the
// same ConnectionTrust.classify() call (see connection-trust.test.ts for the
// pure-function cases and ws.test.ts for a live remote WS connection).
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { buildApp, type AppContext } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';
import type { Session } from '../types.js';
import { CollaboratorService } from '../collaborators/service.js';
import { Store } from '../store/index.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const REMOTE_IP = '100.101.102.103';
const TOKEN = 'a-real-remote-access-token-0123456789';

function makeApp(overrides: Partial<AppContext> = {}) {
  return buildApp({
    config: defaultConfig(),
    manager: {} as RouteContext['manager'],
    ...overrides,
  });
}

describe('Repository verification policy routes', () => {
  let app: ReturnType<typeof Fastify>;
  let store: Store;
  afterEach(async () => { await app.close(); store.close(); });

  it('lets the local admin configure and read required gates before a Run starts', async () => {
    store = new Store(':memory:');
    store.upsertRepo({ id: '/repos/example', name: 'example', path: '/repos/example' });
    app = makeApp({ store });
    const policy = { kind: 'required', gates: [{ name: 'tests', command: 'npm test' }] };

    const saved = await app.inject({
      method: 'PUT', url: '/api/repos/verification-policy', payload: { repoId: '/repos/example', policy },
    });
    const read = await app.inject({
      method: 'GET', url: '/api/repos/verification-policy?repoId=%2Frepos%2Fexample',
    });

    expect(saved.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ policy });
  });

  it('rejects empty required policies', async () => {
    store = new Store(':memory:');
    store.upsertRepo({ id: '/repos/example', name: 'example', path: '/repos/example' });
    app = makeApp({ store });

    const response = await app.inject({
      method: 'PUT', url: '/api/repos/verification-policy',
      payload: { repoId: '/repos/example', policy: { kind: 'required', gates: [] } },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('host/origin/CSP agreement (ticket 05)', () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => { await app.close(); });

  it('loopback: allowed, no token required, CSP connect-src names the loopback host', async () => {
    app = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4040' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("connect-src 'self' ws://127.0.0.1:4040");
  });

  it('tailnet host with a valid token: allowed, CSP connect-src names the tailnet host', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({
      method: 'GET', url: '/api/health',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain(`connect-src 'self' ws://${REMOTE_HOST}:4040`);
  });

  it('bound raw IP is accepted consistently by REST, same-origin checks, CSP, and /api/connection', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      remoteHosts: [REMOTE_HOST, REMOTE_IP],
    });
    const headers = {
      host: `${REMOTE_IP}:4040`,
      origin: `http://${REMOTE_IP}:4040`,
      [TOKEN_HEADER]: TOKEN,
    };
    const health = await app.inject({ method: 'GET', url: '/api/health', headers });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-security-policy']).toContain(`connect-src 'self' ws://${REMOTE_IP}:4040`);

    const connection = await app.inject({ method: 'GET', url: '/api/connection', headers });
    expect(connection.statusCode).toBe(200);
    expect(connection.json()).toEqual({ kind: 'remote', capabilities: ['view', 'compose', 'control-keys'] });
  });

  it('tailnet host without a token: another /api/* route 403s, but the CSP still names the host (page must load to prompt for the token)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-security-policy']).toContain(`connect-src 'self' ws://${REMOTE_HOST}:4040`);
  });

  it('tailnet host without a token: GET /api/connection is exempt from the gate and reports the classification', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: 'GET', url: '/api/connection', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'remote', capabilities: [] });
  });

  it('tailnet host with a valid token: GET /api/connection reports non-empty capabilities', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({
      method: 'GET', url: '/api/connection',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'remote', capabilities: ['view', 'compose', 'control-keys'] });
  });

  it('loopback: GET /api/connection reports local with all four capabilities', async () => {
    app = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/connection', headers: { host: '127.0.0.1:4040' } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { kind: string; capabilities: string[] };
    expect(body.kind).toBe('local');
    expect(new Set(body.capabilities)).toEqual(new Set(['view', 'compose', 'control-keys', 'raw-write']));
  });

  it('unknown host: 403 outright, CSP falls back to no ws:// entry', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:4040' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; base-uri 'none'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  });

  it('a non-/api path is never blocked by the remote-token gate (the SPA shell must stay reachable pre-auth)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: 'GET', url: '/', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).not.toBe(403);
  });

  it('a wrong token on the tailnet host still 403s /api/* routes (not just a missing one)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({
      method: 'GET', url: '/api/health',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: 'wrong-token' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('named collaborator device credentials (ticket 11)', () => {
  let app: ReturnType<typeof Fastify>;
  let store: Store;
  let collaborators: CollaboratorService;
  afterEach(async () => { await app.close(); store.close(); });

  function build(overrides: Partial<AppContext> = {}) {
    store = new Store(':memory:');
    collaborators = new CollaboratorService(store);
    app = makeApp({ remoteHosts: [REMOTE_HOST], collaborators, store, ...overrides });
  }

  it('POST /api/collaborators/exchange works pre-authentication, same exemption as GET /api/connection (AC1)', async () => {
    build();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange',
      headers: { host: `${REMOTE_HOST}:4040`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code, deviceLabel: 'phone' }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { token: string; principal: { displayName: string } };
    expect(body.principal.displayName).toBe('Alice');
    expect(body.token.length).toBeGreaterThan(20);
  });

  it('an exchanged device token authenticates subsequent /api/connection requests as remote+authenticated, naming the collaborator Principal (ticket 12 AC6)', async () => {
    build();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const exchanged = (await app.inject({
      method: 'POST', url: '/api/collaborators/exchange',
      headers: { host: `${REMOTE_HOST}:4040`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code, deviceLabel: 'phone' }),
    })).json() as { token: string; principal: { id: string } };

    const connection = await app.inject({
      method: 'GET', url: '/api/connection',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: exchanged.token },
    });
    expect(connection.json()).toEqual({
      kind: 'remote', capabilities: ['view', 'compose', 'control-keys'],
      principal: { id: exchanged.principal.id, displayName: 'Alice' },
    });
  });

  it('a collaborator device can view GET /api/repos, filtered to its grants (AC4) — never reachable by the legacy shared token alone', async () => {
    // A projectsDir that can't be scanned (ENOENT) forces GET /api/repos to
    // fall back to the store's own listRepos() — otherwise scanRepos()
    // would rescan this real machine's filesystem and never see the
    // fixture repos seeded below at all.
    build({ config: { ...defaultConfig(), tailscaleToken: 'the-shared-token', projectsDir: '/nonexistent/agentdeck-test-projects-dir' } });
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    store.upsertRepo({ id: 'repo-1', name: 'granted', path: '/tmp/repo-1' });
    store.upsertRepo({ id: 'repo-2', name: 'ungranted', path: '/tmp/repo-2' });

    const asCollaborator = await app.inject({
      method: 'GET', url: '/api/repos',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token },
    });
    expect(asCollaborator.statusCode).toBe(200);
    expect((asCollaborator.json() as { id: string }[]).map((r) => r.id)).toEqual(['repo-1']);

    // The legacy shared token is a different bearer value entirely, but
    // even the admin's own remote device (were it using the shared token)
    // never reaches this route — see isCollaboratorViewRoute's comment in
    // app.ts. Confirmed by refusing the wrong token outright here (a right
    // token for the *shared* path 403s the same way GET /api/runs already
    // does in the allowlist suite above).
    const asSharedToken = await app.inject({
      method: 'GET', url: '/api/repos',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: 'the-shared-token' },
    });
    expect(asSharedToken.statusCode).toBe(403);
  });

  it.each([
    ['GET', '/api/sessions'],
    ['POST', '/api/sessions/some-id/send'],
    ['GET', '/api/runs/some-id/activity'],
    ['POST', '/api/runs/some-id/publish'],
  ])(
    'a collaborator device stays refused %s %s — session terminals, the admin-only activity audit trail, and publication are never in scope, only grant-checked Run/Repository/Profile routes (ticket 12 AC1/AC5, ticket 13 AC2)',
    async (method, url) => {
      build();
      const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
      const { token } = collaborators.exchangeInvitation(code, 'phone');
      const response = await app.inject({
        method: method as 'GET' | 'POST', url,
        headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' },
        payload: method === 'GET' ? undefined : '{}',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'this endpoint is not available on a remote connection' });
    },
  );

  it.each([
    ['GET', '/api/runs/attention'],
    ['POST', '/api/runs'],
    ['POST', '/api/runs/some-id/prepare'],
    ['POST', '/api/runs/some-id/start'],
    ['POST', '/api/runs/some-id/cancel'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/approve'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/deny'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/input'],
  ])(
    'a collaborator device reaches %s %s (ticket 12 AC1: allowlisted at the gate — no work routes are registered on this bare app, so 404 "not found" rather than 403 "blocked at the gate" proves that)',
    async (method, url) => {
      build();
      const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
      const { token } = collaborators.exchangeInvitation(code, 'phone');
      const response = await app.inject({
        method: method as 'GET' | 'POST', url,
        headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' },
        payload: method === 'GET' ? undefined : '{}',
      });
      expect(response.statusCode).toBe(404);
    },
  );

  it('a collaborator device reaches GET /api/profiles, filtered to its grantedProfileIds (ticket 12 AC1) — registered directly on buildApp, unlike the work routes above', async () => {
    build();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice', grantedProfileIds: ['profile-1'] });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    store.createProfile({
      id: 'profile-1', name: 'Granted', runtimePreference: ['codex'],
      budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.createProfile({
      id: 'profile-2', name: 'Ungranted', runtimePreference: ['codex'],
      budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'GET', url: '/api/profiles', headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { id: string }[]).map((p) => p.id)).toEqual(['profile-1']);
  });

  it('the legacy shared token keeps its own pre-ticket allowlist (GET /api/sessions) even when collaborators are configured on the same app', async () => {
    build({
      config: { ...defaultConfig(), tailscaleToken: 'the-shared-token' },
      manager: { listSessions: () => [] } as unknown as RouteContext['manager'],
    });
    const response = await app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: 'the-shared-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('a revoked device is refused on its very next request (AC5) — REST needs no separate teardown', async () => {
    build();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: [] });
    const { device, token } = collaborators.exchangeInvitation(code, 'phone');

    const before = await app.inject({ method: 'GET', url: '/api/repos', headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token } });
    expect(before.statusCode).toBe(200);

    collaborators.revokeDevice(device.id);

    const after = await app.inject({ method: 'GET', url: '/api/repos', headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token } });
    expect(after.statusCode).toBe(403);
  });

  it.each([
    ['POST', '/api/collaborators'],
    ['GET', '/api/collaborators'],
    ['PATCH', '/api/collaborators/some-id'],
    ['POST', '/api/collaborators/some-id/invitations'],
    ['POST', '/api/collaborators/devices/some-id/revoke'],
  ])('admin route %s %s is local-only — refused on an authenticated collaborator device connection', async (method, url) => {
    build();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PATCH', url,
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' },
      payload: method === 'GET' ? undefined : '{}',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'this endpoint is not available on a remote connection' });
  });

  it('the local admin can create a collaborator, list devices, and revoke one, all over loopback (AC1/AC2)', async () => {
    build();
    const created = await app.inject({
      method: 'POST', url: '/api/collaborators', headers: { host: '127.0.0.1:4040', 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] }),
    });
    expect(created.statusCode).toBe(201);
    const { code, collaborator } = created.json() as { code: string; collaborator: { id: string } };

    const exchanged = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange',
      headers: { host: `${REMOTE_HOST}:4040`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code, deviceLabel: 'phone' }),
    });
    const { device } = exchanged.json() as { device: { id: string } };

    const listed = await app.inject({ method: 'GET', url: '/api/collaborators', headers: { host: '127.0.0.1:4040' } });
    const rows = listed.json() as { id: string; displayName: string; devices: { id: string; deviceLabel: string }[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: collaborator.id, displayName: 'Alice', grantedRepositoryIds: ['repo-1'] });
    expect(rows[0]!.devices).toEqual([expect.objectContaining({ id: device.id, deviceLabel: 'phone' })]);

    const revoked = await app.inject({
      method: 'POST', url: `/api/collaborators/devices/${device.id}/revoke`, headers: { host: '127.0.0.1:4040' },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { revokedAt?: string }).revokedAt).toEqual(expect.any(String));
  });
});

describe('remote route allowlist (code-review finding: an authenticated remote connection must not get the full local REST surface)', () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => { await app.close(); });

  function remoteHeaders(): Record<string, string> {
    return { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: TOKEN };
  }

  const managedSession: Session = {
    id: 'managed-1', origin: 'managed', agent: 'claude', cwd: '/tmp',
    startedAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T00:00:00.000Z',
    status: 'working', statusSource: 'output_heuristic',
  };
  const externalSession: Session = {
    ...managedSession, id: 'external-1', origin: 'external', terminalApp: 'Terminal',
  };

  it('an authenticated remote connection can list sessions (GET /api/sessions is on the allowlist)', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      remoteHosts: [REMOTE_HOST],
      manager: { listSessions: () => [] } as unknown as RouteContext['manager'],
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: remoteHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('remote session lists contain managed sessions only while loopback remains unfiltered', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      remoteHosts: [REMOTE_HOST],
      manager: { listSessions: () => [managedSession, externalSession] } as unknown as RouteContext['manager'],
    });
    const remote = await app.inject({ method: 'GET', url: '/api/sessions', headers: remoteHeaders() });
    expect((remote.json() as Session[]).map((session) => session.id)).toEqual(['managed-1']);

    const local = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: '127.0.0.1:4040' } });
    expect((local.json() as Session[]).map((session) => session.id)).toEqual(['managed-1', 'external-1']);
  });

  it('refuses remote /send for an external session before any terminal adapter can run', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      remoteHosts: [REMOTE_HOST],
      manager: { getSession: () => externalSession } as unknown as RouteContext['manager'],
    });
    const response = await app.inject({
      method: 'POST', url: '/api/sessions/external-1/send',
      headers: { ...remoteHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'hello' }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'external sessions are not available on a remote connection' });
  });

  it('an authenticated remote connection reaches POST /api/sessions/:id/send (the composer route is on the allowlist — not blocked at the app gate)', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      remoteHosts: [REMOTE_HOST],
      manager: { getSession: () => undefined } as unknown as RouteContext['manager'],
    });
    const response = await app.inject({
      method: 'POST', url: '/api/sessions/some-id/send', headers: { ...remoteHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'hello' }),
    });
    // Reaches the route handler (404 "no such session" from the fake
    // manager) rather than 403 — proves this path isn't blocked by the
    // allowlist gate, distinct from the routes below which never reach a
    // handler at all.
    expect(response.statusCode).toBe(404);
  });

  it('an authenticated remote connection is refused GET /api/runs/some-id/attention — only the static /api/runs/attention list route is allowlisted, not a per-Run one', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: 'GET', url: '/api/runs/some-id/attention', headers: remoteHeaders() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'this endpoint is not available on a remote connection' });
  });

  it.each([
    ['GET', '/api/runs/attention'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/approve'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/deny'],
    ['POST', '/api/runs/some-id/attention/some-attention-id/input'],
  ])('an authenticated remote connection reaches %s %s (ticket 07: allowlisted, not blocked at the app gate)', async (method, url) => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: method as 'GET' | 'POST', url, headers: remoteHeaders() });
    // No work routes are registered on this bare app (see makeApp) — a 404
    // (route not found) rather than 403 (blocked at the gate) proves this
    // path isn't blocked by the allowlist, same as the /send test above.
    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['POST', '/api/sessions'],
    ['POST', '/api/runs'],
    ['PATCH', '/api/settings'],
    ['POST', '/api/hooks/install'],
    ['POST', '/api/repos/file-action'],
    ['POST', '/api/sessions/some-id/stop'],
    ['PATCH', '/api/sessions/some-id'],
    ['GET', '/api/runs'],
    ['GET', '/api/runs/some-id'],
    ['POST', '/api/runs/some-id/prepare'],
    ['POST', '/api/runs/some-id/start'],
    ['POST', '/api/runs/some-id/cancel'],
    ['POST', '/api/runs/some-id/publish'],
  ])('an authenticated remote connection is refused %s %s — not on the mobile allowlist, regardless of a valid token', async (method, url) => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHosts: [REMOTE_HOST] });
    const response = await app.inject({ method: method as 'POST' | 'PATCH', url, headers: remoteHeaders() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'this endpoint is not available on a remote connection' });
  });

  it('loopback is completely unaffected by the remote allowlist — every route stays reachable', async () => {
    app = makeApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      manager: { renameSession: () => undefined } as unknown as RouteContext['manager'],
    });
    const response = await app.inject({
      method: 'PATCH', url: '/api/sessions/some-id', headers: { host: '127.0.0.1:4040', 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'renamed' }),
    });
    // Reaches the handler (404, fake manager has no such session) — not
    // the 403 a remote connection would get for the same route.
    expect(response.statusCode).toBe(404);
  });
});
