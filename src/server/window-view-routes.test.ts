// Issue #91: the window-view REST surface through buildApp. The owner chooses
// and stops sharing a window at the Mac; only a paired owner phone may view
// it; collaborators and the shared tailnet token get nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { Store } from '../store/index.js';
import { EDITOR, fakeCaptureDriver, type FakeCaptureDriver } from '../test-fixtures/fake-capture.js';
import { WindowViewService } from '../window-view/service.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };
const remote = (token: string) => ({ host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token });

let base: string;
let store: Store;
let collaborators: CollaboratorService;
let ownerPairing: OwnerPairingService;
let driver: FakeCaptureDriver;
let windowView: WindowViewService;
let app: FastifyInstance;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-window-view-routes-'));
  store = new Store(path.join(base, 'agentdeck.db'));
  collaborators = new CollaboratorService(store);
  ownerPairing = new OwnerPairingService(store.ownerDevices);
  driver = fakeCaptureDriver();
  windowView = new WindowViewService({ driver });
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    ownerPairing,
    store,
    windowView: { service: windowView, openSettings: async () => undefined },
  });
});

afterEach(async () => {
  windowView.shutdown();
  await app.close();
  store.close();
  fs.rmSync(base, { recursive: true, force: true });
});

function pairPhone(label = 'Sam’s iPhone'): { credential: string; deviceId: string } {
  const challenge = ownerPairing.create();
  const { nonce, code } = ownerPairing.join(challenge.id, challenge.secret, label);
  ownerPairing.confirmOwner(challenge.id, code);
  ownerPairing.confirmPhone(challenge.id, nonce, code);
  return ownerPairing.collect(challenge.id, nonce)!;
}

async function share(): Promise<void> {
  const chosen = await app.inject({ method: 'POST', url: '/api/window-view/select', headers: LOCAL, payload: { windowId: EDITOR.id } });
  expect(chosen.statusCode).toBe(200);
}

describe('window view at the Mac (issue #91)', () => {
  it('shows permission, lists windows, shares one, and shows who is viewing', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/window-view', headers: LOCAL })).json()).toMatchObject({ permission: 'granted', window: null, live: null });
    const windows = (await app.inject({ method: 'GET', url: '/api/window-view/windows', headers: LOCAL })).json() as { id: number }[];
    expect(windows.map((window) => window.id)).toEqual([101, 202]);
    await share();

    const { credential } = pairPhone();
    expect((await app.inject({ method: 'POST', url: '/api/window-view/start', headers: remote(credential) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/window-view', headers: LOCAL })).json()).toMatchObject({
      window: { app: 'TextEdit', title: 'Notes.txt' }, live: { viewer: 'Sam’s iPhone' },
    });

    expect((await app.inject({ method: 'POST', url: '/api/window-view/stop', headers: LOCAL })).statusCode).toBe(200);
    expect(driver.captures[0]!.stopped).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/window-view/clear', headers: LOCAL })).json()).toMatchObject({ window: null });
  });

  it('explains denied permission with a way to fix it', async () => {
    driver.permissionState = 'denied';
    const status = (await app.inject({ method: 'GET', url: '/api/window-view', headers: LOCAL })).json() as { permission: string; permissionHelp: string };
    expect(status.permission).toBe('denied');
    expect(status.permissionHelp).toMatch(/Privacy & Security › Screen Recording/);
    const listing = await app.inject({ method: 'GET', url: '/api/window-view/windows', headers: LOCAL });
    expect(listing.statusCode).toBe(409);
    expect(listing.json()).toMatchObject({ code: 'permission-denied' });
    expect((await app.inject({ method: 'POST', url: '/api/window-view/permission', headers: LOCAL })).json()).toMatchObject({ permission: 'denied' });
    expect(driver.requests).toBe(1);
  });
});

describe('window view from a paired owner phone (issue #91)', () => {
  it('starts, receives frames of only the shared window, and stops, with each step audited', async () => {
    await share();
    const { credential, deviceId } = pairPhone();
    const headers = remote(credential);
    expect((await app.inject({ method: 'GET', url: '/api/window-view/phone', headers })).json()).toMatchObject({
      window: { app: 'TextEdit', title: 'Notes.txt' }, viewing: null,
    });
    const started = await app.inject({ method: 'POST', url: '/api/window-view/start', headers });
    const { viewId } = started.json() as { viewId: string };
    expect(driver.captures.map((capture) => capture.window.id)).toEqual([EDITOR.id]);

    driver.captures[0]!.events.onFrame({ jpeg: Buffer.from('jpeg-bytes'), width: 320, height: 200 });
    const frame = await app.inject({ method: 'GET', url: `/api/window-view/frame?view=${viewId}&after=0&wait=0`, headers });
    expect(frame.json()).toMatchObject({ frame: { seq: 1, width: 320, height: 200, jpeg: Buffer.from('jpeg-bytes').toString('base64') } });
    const none = await app.inject({ method: 'GET', url: `/api/window-view/frame?view=${viewId}&after=1&wait=0`, headers });
    expect(none.json()).toEqual({ frame: null });

    expect((await app.inject({ method: 'POST', url: '/api/window-view/stop', headers, payload: { viewId } })).statusCode).toBe(200);
    expect(driver.captures[0]!.stopped).toBe(true);
    const after = await app.inject({ method: 'GET', url: `/api/window-view/frame?view=${viewId}&after=1&wait=0`, headers });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ code: 'not-viewing', error: 'You stopped viewing.' });
    expect(ownerPairing.listAudit(deviceId).map((entry) => entry.action).sort()).toEqual(['window-view-start', 'window-view-stop']);
  });

  it('may not choose a window, list windows, or read the Mac view', async () => {
    const headers = remote(pairPhone().credential);
    for (const [method, url] of [['GET', '/api/window-view'], ['GET', '/api/window-view/windows'], ['POST', '/api/window-view/select'], ['POST', '/api/window-view/clear'], ['POST', '/api/window-view/permission']] as const) {
      expect((await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: { windowId: EDITOR.id } } : {}) })).statusCode, url).toBe(403);
    }
    expect(windowView.status().window).toBeNull();
  });

  it('refuses a start with an explanation when Screen Recording is off', async () => {
    await share();
    driver.permissionState = 'denied';
    const refused = await app.inject({ method: 'POST', url: '/api/window-view/start', headers: remote(pairPhone().credential) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'permission-denied', error: expect.stringMatching(/Screen Recording/) });
    expect(driver.captures).toHaveLength(0);
  });

  it('ends the stream at once when the phone is revoked, and the phone gets nothing after', async () => {
    await share();
    const { credential, deviceId } = pairPhone();
    const { viewId } = (await app.inject({ method: 'POST', url: '/api/window-view/start', headers: remote(credential) })).json() as { viewId: string };
    expect((await app.inject({ method: 'POST', url: `/api/owner-devices/${deviceId}/revoke`, headers: LOCAL })).statusCode).toBe(200);
    expect(driver.captures[0]!.stopped).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/window-view/frame?view=${viewId}&after=0&wait=0`, headers: remote(credential) })).statusCode).toBe(403);
  });

  it('does not let one phone stop or read another phone’s view', async () => {
    await share();
    const first = pairPhone('First');
    const second = pairPhone('Second');
    const { viewId } = (await app.inject({ method: 'POST', url: '/api/window-view/start', headers: remote(first.credential) })).json() as { viewId: string };
    expect((await app.inject({ method: 'GET', url: `/api/window-view/frame?view=${viewId}&after=0&wait=0`, headers: remote(second.credential) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/window-view/stop', headers: remote(second.credential), payload: { viewId } })).statusCode).toBe(409);
    expect(driver.captures[0]!.stopped).toBe(false);
  });
});

describe('window view for anyone else (issue #91)', () => {
  const routes = [
    ['GET', '/api/window-view'], ['GET', '/api/window-view/windows'], ['GET', '/api/window-view/phone'],
    ['GET', '/api/window-view/frame?view=x&after=0'], ['POST', '/api/window-view/start'], ['POST', '/api/window-view/stop'],
    ['POST', '/api/window-view/select'], ['POST', '/api/window-view/clear'], ['POST', '/api/window-view/permission'],
    ['POST', '/api/window-view/permission/settings'],
  ] as const;

  it('refuses a collaborator device and the shared tailnet token on every route', async () => {
    await share();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    for (const credential of [token, SHARED_TOKEN]) {
      for (const [method, url] of routes) {
        expect((await app.inject({ method, url, headers: remote(credential) })).statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(driver.captures).toHaveLength(0);
    expect(windowView.status().window).toMatchObject({ app: 'TextEdit' });
    expect(driver.requests).toBe(0);
  });
});
