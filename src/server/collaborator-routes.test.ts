// Ticket 11: input validation and error-shape coverage for the
// Collaborators REST surface (registerCollaboratorRoutes). The
// authentication/authorization side — pre-auth exchange, local-only admin
// routes, grant-filtered viewing, revocation — is covered end to end in
// app.test.ts's "named collaborator device credentials" suite, which
// exercises the full onRequest hook these routes sit behind; this file is
// about the routes' own request/response shapes in isolation.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { CollaboratorService } from '../collaborators/service.js';
import { registerCollaboratorRoutes } from './collaborator-routes.js';

let app: ReturnType<typeof Fastify>;
let store: Store;
let collaborators: CollaboratorService;

function makeApp() {
  store = new Store(':memory:');
  collaborators = new CollaboratorService(store);
  app = Fastify();
  registerCollaboratorRoutes(app, collaborators);
  return { app, collaborators };
}

afterEach(async () => {
  await app.close();
  store.close();
});

describe('POST /api/collaborators', () => {
  it('creates a collaborator and returns its one-time invitation code', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { collaborator: { displayName: string }; code: string };
    expect(body.collaborator.displayName).toBe('Alice');
    expect(body.code.length).toBeGreaterThan(20);
  });

  it('400s a missing displayName', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'displayName is required' });
  });

  it('400s a non-array grantedRepositoryIds', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Alice', grantedRepositoryIds: 'repo-1' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'grantedRepositoryIds must be an array of strings' });
  });

  it('defaults grantedRepositoryIds to empty when omitted', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Alice' }),
    });
    expect((response.json() as { collaborator: { grantedRepositoryIds: string[] } }).collaborator.grantedRepositoryIds).toEqual([]);
  });
});

describe('PATCH /api/collaborators/:id', () => {
  it('updates grants for an existing collaborator', async () => {
    const { collaborators: service } = makeApp();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice' });
    const response = await app.inject({
      method: 'PATCH', url: `/api/collaborators/${collaborator.id}`, headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ grantedRepositoryIds: ['repo-9'] }),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { grantedRepositoryIds: string[] }).grantedRepositoryIds).toEqual(['repo-9']);
  });

  it('404s an unknown collaborator id', async () => {
    makeApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/collaborators/nope', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ grantedRepositoryIds: [] }),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/collaborators/:id/invitations', () => {
  it('issues a second invitation to an existing collaborator', async () => {
    const { collaborators: service } = makeApp();
    const { collaborator, code: firstCode } = service.inviteCollaborator({ displayName: 'Alice' });
    const response = await app.inject({ method: 'POST', url: `/api/collaborators/${collaborator.id}/invitations` });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { code: string };
    expect(body.code).not.toBe(firstCode);
  });

  it('404s an unknown collaborator id', async () => {
    makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/collaborators/nope/invitations' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/collaborators/exchange', () => {
  it('exchanges a valid code for a device credential and bearer token', async () => {
    const { collaborators: service } = makeApp();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ code, deviceLabel: 'phone' }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { token: string; principal: { displayName: string } };
    expect(body.principal.displayName).toBe('Alice');
    expect(body.token.length).toBeGreaterThan(20);
  });

  it('400s a missing code', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ deviceLabel: 'phone' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'code is required' });
  });

  it('400s an unknown code with a precise, safe error (never revealing whether a similar code exists)', async () => {
    makeApp();
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'not-a-real-code' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'No such invitation code.' });
  });

  it('400s an already-consumed code', async () => {
    const { collaborators: service } = makeApp();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    service.exchangeInvitation(code, 'first device');
    const response = await app.inject({
      method: 'POST', url: '/api/collaborators/exchange', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ code }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'This invitation has already been used.' });
  });
});

describe('POST /api/collaborators/devices/:deviceId/revoke', () => {
  it('revokes a device and reports its revokedAt timestamp', async () => {
    const { collaborators: service } = makeApp();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { device } = service.exchangeInvitation(code, 'phone');
    const response = await app.inject({ method: 'POST', url: `/api/collaborators/devices/${device.id}/revoke` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { revokedAt?: string }).revokedAt).toEqual(expect.any(String));
  });

  it('404s an unknown device id', async () => {
    makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/collaborators/devices/nope/revoke' });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/collaborators', () => {
  it('lists every collaborator with its devices, never a bearer secret', async () => {
    const { collaborators: service } = makeApp();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token } = service.exchangeInvitation(code, 'phone');
    const response = await app.inject({ method: 'GET', url: '/api/collaborators' });
    expect(response.statusCode).toBe(200);
    const body = JSON.stringify(response.json());
    expect(body).not.toContain(token);
    expect(body).not.toContain(code);
  });
});
