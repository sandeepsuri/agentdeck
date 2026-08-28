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

  it.each([
    ['POST', '/api/sessions'],
    ['PATCH', '/api/settings'],
    ['POST', '/api/hooks/install'],
    ['POST', '/api/repos/file-action'],
    ['POST', '/api/sessions/some-id/stop'],
    ['PATCH', '/api/sessions/some-id'],
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
