// Issue #88: the email reply REST surface, exercised through buildApp so the
// same onRequest gate that protects every other route decides who is the owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { EMAIL_BROKER_MCP_TOOLS } from '../personal-tasks/email/email-broker.js';
import { EmailTaskService } from '../personal-tasks/email/service.js';
import type { EmailAccountView, EmailTaskView } from '../personal-tasks/email/types.js';
import { Store } from '../store/index.js';
import { fakeGmailAccess, FakeMailbox, LEASE_MESSAGE, memoryVault, NEWSLETTER_MESSAGE } from '../test-fixtures/fake-mailbox.js';
import { scriptedFilingProvider } from '../test-fixtures/filing-agent.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };

let dir: string;
let store: Store;
let mailbox: FakeMailbox;
let collaborators: CollaboratorService;
let ownerPairing: OwnerPairingService;
let service: EmailTaskService;
let app: FastifyInstance;
const vault = memoryVault();

function boot(): void {
  store = new Store(path.join(dir, 'agentdeck.db'));
  collaborators = new CollaboratorService(store);
  ownerPairing = new OwnerPairingService(store.ownerDevices);
  service = new EmailTaskService({
    repository: store.email,
    gmail: fakeGmailAccess(mailbox),
    vault,
    provider: scriptedFilingProvider({
      script: async (call) => {
        await call('search_messages', { query: 'lease' });
        await call('propose_reply', { message: 'msg-1', body: 'Yes, by Friday.' });
      },
      turn: { toolsOffered: EMAIL_BROKER_MCP_TOOLS },
    }),
  });
  service.recover();
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    ownerPairing,
    store,
    emailTasks: { service },
  });
}

async function shutdown(): Promise<void> {
  await service.whenIdle();
  await app.close();
  store.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-email-routes-'));
  mailbox = new FakeMailbox('owner@gmail.com', [LEASE_MESSAGE, NEWSLETTER_MESSAGE]);
  boot();
});

afterEach(async () => {
  await shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function foundTask(): Promise<EmailTaskView> {
  const connected = await app.inject({ method: 'POST', url: '/api/personal/email/accounts/connect', headers: LOCAL });
  expect(connected.statusCode).toBe(201);
  const account = (connected.json() as { account: EmailAccountView }).account;
  const submitted = await app.inject({ method: 'POST', url: '/api/personal/email/tasks', headers: LOCAL, payload: { accountId: account.id, request: 'Pat lease email; say yes' } });
  expect(submitted.statusCode).toBe(201);
  await service.whenIdle();
  return (await app.inject({ method: 'GET', url: `/api/personal/email/tasks/${(submitted.json() as EmailTaskView).id}`, headers: LOCAL })).json() as EmailTaskView;
}

describe('email reply routes', () => {
  it('lets the owner find, confirm, draft, and edit a reply that survives a restart, and never send', async () => {
    const task = await foundTask();
    expect(task.result?.candidates[0]).toMatchObject({ from: 'Pat Landlord <pat@example.test>', subject: 'Lease renewal' });

    const confirmed = await app.inject({ method: 'POST', url: `/api/personal/email/tasks/${task.id}/confirm`, headers: LOCAL, payload: { messageId: 'gm-lease' } });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as EmailTaskView).drafts[0]).toMatchObject({ version: 1, state: 'saved', content: { body: 'Yes, by Friday.' } });

    const edited = await app.inject({
      method: 'POST', url: `/api/personal/email/tasks/${task.id}/draft`, headers: LOCAL,
      payload: { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'Yes, by Thursday.' },
    });
    expect(edited.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST', url: `/api/personal/email/tasks/${task.id}/draft`, headers: LOCAL,
      payload: { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'x', body: 'y' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'stale-draft' });
    const bad = await app.inject({
      method: 'POST', url: `/api/personal/email/tasks/${task.id}/draft`, headers: LOCAL,
      payload: { baseVersion: 2, to: ['nobody'], cc: [], subject: 'x', body: 'y' },
    });
    expect(bad.statusCode).toBe(400);

    await shutdown();
    boot();
    const reopened = (await app.inject({ method: 'GET', url: `/api/personal/email/tasks/${task.id}`, headers: LOCAL })).json() as EmailTaskView;
    expect(reopened.drafts.map((draft) => [draft.version, draft.content.body])).toEqual([[2, 'Yes, by Thursday.'], [1, 'Yes, by Friday.']]);
    expect(mailbox.drafts.size).toBe(1);

    for (const url of [`/api/personal/email/tasks/${task.id}/send`, `/api/personal/email/tasks/${task.id}/draft/send`]) {
      expect((await app.inject({ method: 'POST', url, headers: LOCAL })).statusCode).toBe(404);
    }
  });

  it('refuses a collaborator device, the shared token, and a paired owner phone', async () => {
    const task = await foundTask();
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    const challenge = ownerPairing.create();
    const joined = ownerPairing.join(challenge.id, challenge.secret, 'Owner iPhone');
    ownerPairing.confirmOwner(challenge.id, joined.code);
    ownerPairing.confirmPhone(challenge.id, joined.nonce, joined.code);
    const phone = ownerPairing.collect(challenge.id, joined.nonce)!;

    for (const credential of [token, SHARED_TOKEN, phone.credential]) {
      const headers = { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: credential };
      for (const [method, url] of [
        ['GET', '/api/personal/email/accounts'], ['GET', '/api/personal/email/tasks'], ['GET', `/api/personal/email/tasks/${task.id}`],
        ['POST', '/api/personal/email/accounts/connect'], ['POST', `/api/personal/email/tasks/${task.id}/confirm`], ['POST', `/api/personal/email/tasks/${task.id}/draft`],
      ] as const) {
        const response = await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: { messageId: 'gm-lease' } } : {}) });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect((await app.inject({ method: 'GET', url: `/api/personal/email/tasks/${task.id}`, headers: LOCAL })).json()).not.toHaveProperty('confirmed');
  });

  it('shows the repair state for a build without a Gmail client', async () => {
    await shutdown();
    store = new Store(path.join(dir, 'agentdeck.db'));
    service = new EmailTaskService({ repository: store.email, gmail: fakeGmailAccess(mailbox, { client: false }), vault });
    app = buildApp({ config: defaultConfig(), manager: {} as RouteContext['manager'], store, emailTasks: { service } });
    const response = await app.inject({ method: 'POST', url: '/api/personal/email/accounts/connect', headers: LOCAL });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'no-client' });
  });

  it('refuses searching a revoked account', async () => {
    const connected = await app.inject({ method: 'POST', url: '/api/personal/email/accounts/connect', headers: LOCAL });
    const account = (connected.json() as { account: EmailAccountView }).account;
    expect((await app.inject({ method: 'POST', url: `/api/personal/email/accounts/${account.id}/revoke`, headers: LOCAL })).statusCode).toBe(200);
    const submitted = await app.inject({ method: 'POST', url: '/api/personal/email/tasks', headers: LOCAL, payload: { accountId: account.id, request: 'x' } });
    expect(submitted.statusCode).toBe(409);
    expect(submitted.json()).toMatchObject({ code: 'account-revoked' });
  });
});
