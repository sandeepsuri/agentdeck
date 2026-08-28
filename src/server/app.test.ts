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

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
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
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({
      method: 'GET', url: '/api/health',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain(`connect-src 'self' ws://${REMOTE_HOST}:4040`);
  });

  it('tailnet host without a token: another /api/* route 403s, but the CSP still names the host (page must load to prompt for the token)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-security-policy']).toContain(`connect-src 'self' ws://${REMOTE_HOST}:4040`);
  });

  it('tailnet host without a token: GET /api/connection is exempt from the gate and reports the classification', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({ method: 'GET', url: '/api/connection', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'remote', capabilities: [] });
  });

  it('tailnet host with a valid token: GET /api/connection reports non-empty capabilities', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
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
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:4040' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; base-uri 'none'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  });

  it('a non-/api path is never blocked by the remote-token gate (the SPA shell must stay reachable pre-auth)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({ method: 'GET', url: '/', headers: { host: `${REMOTE_HOST}:4040` } });
    expect(response.statusCode).not.toBe(403);
  });

  it('a wrong token on the tailnet host still 403s /api/* routes (not just a missing one)', async () => {
    app = makeApp({ config: { ...defaultConfig(), tailscaleToken: TOKEN }, remoteHost: REMOTE_HOST });
    const response = await app.inject({
      method: 'GET', url: '/api/health',
      headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: 'wrong-token' },
    });
    expect(response.statusCode).toBe(403);
  });
});
