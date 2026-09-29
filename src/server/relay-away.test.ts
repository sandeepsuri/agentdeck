// Issue #90: an owner phone away from home, end to end: a real relay, the
// Mac's outbound link, and the phone's side of the channel, with no Tailscale
// host at all. The Mac keeps the task database and does the work; the relay
// only ever carries sealed frames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultConfig } from '../config.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { PersonalTaskService } from '../personal-tasks/service.js';
import { isFilingProposal, type FolderGrantView, type PersonalTaskView } from '../personal-tasks/types.js';
import { generateStaticKey, type StaticKey } from '../relay/channel.js';
import { connectPhone, RelayUnavailable, type PhoneRelayClient } from '../relay/phone-client.js';
import type { RelayLinkInfo } from '../relay/protocol.js';
import { startRelay, type RunningRelay } from '../relay/server.js';
import { RelayService } from '../relay/service.js';
import { Store } from '../store/index.js';
import { memoryVault } from '../test-fixtures/fake-mailbox.js';
import { scriptedFilingProvider, type BrokerCall } from '../test-fixtures/filing-agent.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import { relayDispatcher } from './relay-dispatch.js';
import type { RouteContext } from './routes.js';

const PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 3 >>\nendobj\n%%EOF\n';
const LOCAL = { host: '127.0.0.1:4040' };
const TAILNET = 'my-mac.tailnet-1234.ts.net';

let base: string;
let home: string;
let folder: string;
let store: Store;
let pairing: OwnerPairingService;
let service: PersonalTaskService;
let relayService: RelayService;
let relay: RunningRelay;
let app: FastifyInstance;
let saved: string | undefined;
const vault = memoryVault();
const clients: PhoneRelayClient[] = [];

const fileJanuary = async (call: BrokerCall) => {
  const documents = JSON.parse((await call('list_documents')).text) as { document: string; name: string }[];
  for (const document of documents) {
    await call('read_document', { document: document.document });
    await call('propose_filing', { document: document.document, new_name: 'January.pdf', destination: 'Bills' });
  }
};

async function boot(options: { tailnet?: boolean } = {}): Promise<void> {
  store = new Store(path.join(base, 'agentdeck.db'));
  pairing = new OwnerPairingService(store.ownerDevices);
  service = new PersonalTaskService({ repository: store.personal, homeDir: home, filingProvider: scriptedFilingProvider({ script: fileJanuary }) });
  service.recover();
  relayService = new RelayService({
    vault, url: relay.url, save: (url) => { saved = url; }, lookupPhone: (key) => pairing.byPublicKey(key), retryMs: 20,
  });
  pairing.onRevoke((id) => relayService.dropDevice(id));
  app = buildApp({
    config: defaultConfig(),
    manager: {} as RouteContext['manager'],
    ...(options.tailnet ? { remoteHosts: [TAILNET] } : {}),
    ownerPairing: pairing,
    store,
    personalTasks: { service, pickFolder: async () => folder },
    relay: relayService,
  });
  relayService.attach(relayDispatcher(app, pairing));
  await relayService.start();
  await until(() => relayService.status().state === 'connected');
}

async function shutdown(): Promise<void> {
  for (const client of clients.splice(0)) client.close();
  relayService.stop();
  await service.whenIdle();
  await app.close();
  store.close();
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function phone(link: RelayLinkInfo, key: StaticKey): Promise<PhoneRelayClient> {
  const client = await connectPhone(link, key, 3_000);
  clients.push(client);
  return client;
}

/** Everything any WebSocket in this process sends: the relay's view and more. */
function recordFrames(): string[] {
  const frames: string[] = [];
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(this: WebSocket, data: unknown, ...rest: unknown[]) {
    frames.push(String(data));
    return (original as (...args: unknown[]) => void).call(this, data, ...rest);
  } as typeof original;
  afterEachRestore.push(() => { WebSocket.prototype.send = original; });
  return frames;
}
const afterEachRestore: Array<() => void> = [];

/** Pairs a phone entirely through the relay, the way AgentDeck Phone does from the QR code. */
async function pairThroughRelay(key: StaticKey = generateStaticKey()): Promise<{ credential: string; deviceId: string; link: RelayLinkInfo; key: StaticKey }> {
  const created = await app.inject({ method: 'POST', url: '/api/owner-pairing/challenges', headers: LOCAL });
  expect(created.statusCode).toBe(200);
  const qr = new URL((created.json() as { pairingUrl: string }).pairingUrl);
  expect(qr.searchParams.get('base')).toBeNull();
  const link = { url: qr.searchParams.get('relay')!, mailbox: qr.searchParams.get('mailbox')!, macKey: qr.searchParams.get('mac')! };
  const id = qr.searchParams.get('id')!;
  const client = await phone(link, key);
  const joined = await client.request('POST', '/api/owner-pairing/join', { body: { id, secret: qr.searchParams.get('secret'), label: 'Away iPhone' } });
  expect(joined.status).toBe(200);
  const { nonce, code } = joined.body as { nonce: string; code: string };
  expect((await app.inject({ method: 'POST', url: `/api/owner-pairing/challenges/${id}/confirm`, headers: LOCAL, payload: { code } })).statusCode).toBe(200);
  expect((await client.request('POST', '/api/owner-pairing/phone-confirm', { body: { id, nonce, code } })).status).toBe(200);
  const collected = await client.request('POST', '/api/owner-pairing/collect', { body: { id, nonce } });
  const issued = collected.body as { credential: string; deviceId: string; relay: RelayLinkInfo };
  expect(issued.relay).toEqual(link);
  return { credential: issued.credential, deviceId: issued.deviceId, link, key };
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-relay-away-')));
  home = path.join(base, 'home');
  folder = path.join(home, 'Documents', 'Statements');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'january.pdf'), PDF);
  relay = await startRelay({ port: 0, host: '127.0.0.1' });
  await boot();
});

afterEach(async () => {
  for (const restore of afterEachRestore.splice(0)) restore();
  await shutdown();
  await relay.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('an owner phone away from home (issue #90)', () => {
  it('pairs, submits, follows, and approves a filing proposal through the relay, which never sees task content', async () => {
    const frames = recordFrames();
    const grant = (await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL })).json() as { grant: FolderGrantView };
    const { credential, deviceId, link, key } = await pairThroughRelay();
    const client = await phone(link, key);
    const call = (method: string, url: string, body?: unknown) => client.request(method, url, { token: credential, ...(body === undefined ? {} : { body }) });

    const grants = await call('GET', '/api/personal/grants');
    expect((grants.body as FolderGrantView[]).map((entry) => entry.id)).toEqual([grant.grant.id]);
    const created = await call('POST', '/api/personal/tasks', { kind: 'pdf-filing-proposal', grantId: grant.grant.id, files: ['january.pdf'] });
    expect(created.status).toBe(201);
    const { id } = created.body as PersonalTaskView;
    await service.whenIdle();
    const proposed = (await call('GET', `/api/personal/tasks/${id}`)).body as PersonalTaskView;
    if (!proposed.result || !isFilingProposal(proposed.result)) throw new Error(`no proposal: ${proposed.failure}`);
    expect((await call('POST', `/api/personal/tasks/${id}/filing/approve`, { planDigest: proposed.result.planDigest })).status).toBe(200);
    await service.whenIdle();

    expect(fs.existsSync(path.join(folder, 'Bills', 'January.pdf'))).toBe(true);
    const done = (await call('GET', `/api/personal/tasks/${id}`)).body as PersonalTaskView;
    expect(done.filing).toMatchObject({ state: 'finished', approvedBy: { device: 'Away iPhone' } });
    expect(pairing.listAudit(deviceId).map((entry) => entry.action).sort()).toEqual(['filing-approve', 'personal-task-submit']);

    // The relay carried every one of these requests and saw none of their content.
    expect(frames.length).toBeGreaterThan(20);
    expect(frames.some((frame) => frame.includes('"t":"msg"'))).toBe(true);
    const seen = frames.join('\n');
    for (const secret of ['january', 'January', 'Statements', 'Bills', credential, 'filing', 'Away iPhone']) expect(seen).not.toContain(secret);
  });

  it('gives a phone the Mac does not know nothing but pairing', async () => {
    await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL });
    const { credential, link } = await pairThroughRelay();
    const stranger = await phone(link, generateStaticKey());
    // Even with a real credential, a key the Mac never paired gets nothing.
    const refused = await stranger.request('GET', '/api/personal/tasks', { token: credential });
    expect(refused.status).toBe(403);
    expect(await stranger.request('GET', '/api/personal/grants')).toMatchObject({ status: 403 });
  });

  it('refuses a paired key that sends another phone’s credential, and every route outside tasks and decisions', async () => {
    const first = await pairThroughRelay();
    const second = await pairThroughRelay();
    const client = await phone(first.link, first.key);
    expect((await client.request('GET', '/api/personal/tasks', { token: second.credential })).status).toBe(403);
    for (const route of ['/api/settings', '/api/owner-devices', '/api/sessions', '/api/runs', '/api/personal/email/tasks']) {
      expect((await client.request('GET', route, { token: first.credential })).status, route).toBe(403);
    }
    expect((await client.request('POST', '/api/owner-pairing/relay-key', { token: first.credential, body: { publicKey: generateStaticKey().publicKey } })).status).toBe(403);
    expect((await client.request('POST', '/api/personal/grants/pick', { token: first.credential })).status).toBe(403);
  });

  it('ends a revoked phone’s relay connection at once, and it cannot come back', async () => {
    const { credential, deviceId, link, key } = await pairThroughRelay();
    const client = await phone(link, key);
    expect((await client.request('GET', '/api/personal/tasks', { token: credential })).status).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/owner-devices/${deviceId}/revoke`, headers: LOCAL })).statusCode).toBe(200);
    await expect(client.request('GET', '/api/personal/tasks', { token: credential })).rejects.toBeInstanceOf(RelayUnavailable);

    const again = await phone(link, key);
    expect((await again.request('GET', '/api/personal/tasks', { token: credential })).status).toBe(403);
    const connection = await again.request('GET', '/api/connection', { token: credential });
    expect(connection.body).toMatchObject({ kind: 'remote', capabilities: [] });
  });

  it('says the Mac is unavailable while it is offline, and restores the same task when it is back', async () => {
    await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL });
    const { credential, link, key } = await pairThroughRelay();
    const grants = (await (await phone(link, key)).request('GET', '/api/personal/grants', { token: credential })).body as FolderGrantView[];
    const created = await (await phone(link, key)).request('POST', '/api/personal/tasks', {
      token: credential, body: { kind: 'pdf-inventory', grantId: grants[0]!.id, files: ['january.pdf'] },
    });
    const { id } = created.body as PersonalTaskView;
    await service.whenIdle();

    await shutdown();
    await expect(connectPhone(link, key, 1_000)).rejects.toBeInstanceOf(RelayUnavailable);

    await boot();
    const restored = await (await phone(link, key)).request('GET', `/api/personal/tasks/${id}`, { token: credential });
    expect(restored.body).toMatchObject({ id, status: 'completed' });
    expect(saved).toBeUndefined();
  });

  it('lets a phone paired over Tailscale before the relay enroll its key directly, then use the relay', async () => {
    await shutdown();
    await boot({ tailnet: true });
    const challenge = pairing.create();
    const joined = pairing.join(challenge.id, challenge.secret, 'Old iPhone');
    pairing.confirmOwner(challenge.id, joined.code);
    pairing.confirmPhone(challenge.id, joined.nonce, joined.code);
    const { credential } = pairing.collect(challenge.id, joined.nonce)!;
    const key = generateStaticKey();
    const direct = { host: `${TAILNET}:4040`, [TOKEN_HEADER]: credential };

    const enrolled = await app.inject({ method: 'POST', url: '/api/owner-pairing/relay-key', headers: direct, payload: { publicKey: key.publicKey } });
    expect(enrolled.statusCode).toBe(200);
    const { relay: link } = enrolled.json() as { relay: RelayLinkInfo };
    expect((await (await phone(link, key)).request('GET', '/api/personal/tasks', { token: credential })).status).toBe(200);
  });

  it('keeps the relay URL the owner saves, and refuses one that is not encrypted', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/owner-pairing/relay', headers: LOCAL, payload: { url: 'ws://relay.example.com' } });
    expect(bad.statusCode).toBe(409);
    const off = await app.inject({ method: 'POST', url: '/api/owner-pairing/relay', headers: LOCAL, payload: { url: '' } });
    expect(off.json()).toEqual({ state: 'off' });
    expect(saved).toBeUndefined();
    const on = await app.inject({ method: 'POST', url: '/api/owner-pairing/relay', headers: LOCAL, payload: { url: relay.url } });
    expect(on.statusCode).toBe(200);
    expect(saved).toBe(relay.url);
    await until(() => relayService.status().state === 'connected');
    expect((await app.inject({ method: 'GET', url: '/api/owner-pairing/relay', headers: LOCAL })).json()).toMatchObject({ state: 'connected', url: relay.url });
  });
});
