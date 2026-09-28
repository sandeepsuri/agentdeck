import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import { Store } from '../store/index.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';
import { CollaboratorService } from '../collaborators/service.js';

const host = 'mac.tailnet.ts.net';
let store: Store;
let app: ReturnType<typeof buildApp>;
afterEach(async () => { await app?.close(); store?.close(); });

describe('owner phone REST boundary', () => {
  it('pairs through local and remote routes, rejects collaborators, and revokes REST immediately', async () => {
    store = new Store(':memory:');
    const ownerPairing = new OwnerPairingService(store.ownerDevices);
    const collaborators = new CollaboratorService(store);
    app = buildApp({ config: defaultConfig(), manager: {} as RouteContext['manager'], ownerPairing, collaborators, remoteHosts: [host] });
    const created = await app.inject({ method: 'POST', url: '/api/owner-pairing/challenges' });
    expect(created.statusCode).toBe(200);
    const qr = created.json() as { id: string; qr: string; pairingUrl: string };
    const uri = Buffer.from(qr.qr.split(',')[1]!, 'base64').toString();
    expect(uri).toContain('<svg');
    expect(qr.pairingUrl).toContain('agentdeck://pair');
    const challenge = ownerPairing.status(qr.id);
    expect(challenge.state).toBe('waiting');
    const secret = new URL(qr.pairingUrl).searchParams.get('secret');
    expect(secret).toBeTruthy();
    const remote = { host };
    const invite = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const collaboratorToken = collaborators.exchangeInvitation(invite.code, 'Alice phone').token;
    const joined = await app.inject({ method: 'POST', url: '/api/owner-pairing/join', headers: remote, payload: { id: qr.id, secret, label: 'Phone' } });
    expect(joined.statusCode).toBe(200);
    const { nonce, code } = joined.json() as { nonce: string; code: string };
    expect((await app.inject({ method: 'POST', url: '/api/owner-pairing/join', headers: remote, payload: { id: qr.id, secret, label: 'Replay' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/owner-devices', headers: remote })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/owner-devices', headers: { host, [TOKEN_HEADER]: collaboratorToken } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/owner-pairing/challenges/${qr.id}/confirm`, headers: remote, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/owner-pairing/phone-confirm', headers: remote, payload: { id: qr.id, nonce, code } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/owner-pairing/challenges/${qr.id}/confirm`, payload: { code } })).statusCode).toBe(200);
    const collected = await app.inject({ method: 'POST', url: '/api/owner-pairing/collect', headers: remote, payload: { id: qr.id, nonce } });
    const { credential, deviceId } = collected.json() as { credential: string; deviceId: string };
    expect(credential).toHaveLength(43);
    ownerPairing.audit(deviceId, 'session-send', 'session-1');
    const audit = await app.inject({ method: 'GET', url: `/api/owner-devices/${deviceId}/audit` });
    expect(audit.json()).toEqual([{ id: expect.any(String), deviceId, action: 'session-send', targetId: 'session-1', createdAt: expect.any(String) }]);
    expect((await app.inject({ method: 'GET', url: `/api/owner-devices/${deviceId}/audit`, headers: { host, [TOKEN_HEADER]: collaboratorToken } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/connection', headers: { host, [TOKEN_HEADER]: credential } })).json().capabilities).toContain('view');
    expect((await app.inject({ method: 'POST', url: `/api/owner-devices/${deviceId}/revoke` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/connection', headers: { host, [TOKEN_HEADER]: credential } })).json().capabilities).toEqual([]);
  });

  it('tells the Mac app its phone access is off and turns it on after replying', async () => {
    store = new Store(':memory:');
    let enabled = false;
    const set = vi.fn((next: boolean) => { enabled = next; });
    app = buildApp({ config: defaultConfig(), manager: {} as RouteContext['manager'], ownerPairing: new OwnerPairingService(store.ownerDevices), remoteHosts: [], phoneAccess: { enabled: () => enabled, set } });
    expect((await app.inject({ method: 'GET', url: '/api/owner-pairing/availability' })).json()).toEqual({ state: 'off', canToggle: true, phoneAccess: false });
    const blocked = await app.inject({ method: 'POST', url: '/api/owner-pairing/challenges' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('Turn on phone access to pair a phone.');
    expect((await app.inject({ method: 'POST', url: '/api/owner-pairing/phone-access', headers: { host }, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/owner-pairing/phone-access', payload: { enabled: 'yes' } })).statusCode).toBe(400);
    const turnedOn = await app.inject({ method: 'POST', url: '/api/owner-pairing/phone-access', payload: { enabled: true } });
    expect(turnedOn.json()).toEqual({ restarting: true });
    expect(set).toHaveBeenCalledWith(true);
    expect((await app.inject({ method: 'GET', url: '/api/owner-pairing/availability' })).json().state).toBe('no-tailscale');
  });

  it('reports ready without a toggle for a CLI service on Tailscale', async () => {
    store = new Store(':memory:');
    app = buildApp({ config: defaultConfig(), manager: {} as RouteContext['manager'], ownerPairing: new OwnerPairingService(store.ownerDevices), remoteHosts: [host] });
    expect((await app.inject({ method: 'GET', url: '/api/owner-pairing/availability' })).json()).toEqual({ state: 'ready', canToggle: false, phoneAccess: true });
    expect((await app.inject({ method: 'POST', url: '/api/owner-pairing/phone-access', payload: { enabled: true } })).statusCode).toBe(409);
  });
});
