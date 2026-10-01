// Issue #92: the routines REST surface, exercised through buildApp so the
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
import { RoutineService } from '../personal-tasks/routines/service.js';
import type { RoutineRunView, RoutineView } from '../personal-tasks/routines/types.js';
import { PersonalTaskService } from '../personal-tasks/service.js';
import type { PersonalActor } from '../personal-tasks/types.js';
import { Store } from '../store/index.js';
import { fakeGmailAccess, FakeMailbox, LEASE_MESSAGE, memoryVault } from '../test-fixtures/fake-mailbox.js';
import { scriptedFilingProvider } from '../test-fixtures/filing-agent.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };
const OWNER: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };

let dir: string;
let store: Store;
let collaborators: CollaboratorService;
let ownerPairing: OwnerPairingService;
let email: EmailTaskService;
let app: FastifyInstance;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-routine-routes-'));
  store = new Store(path.join(dir, 'agentdeck.db'));
  collaborators = new CollaboratorService(store);
  ownerPairing = new OwnerPairingService(store.ownerDevices);
  email = new EmailTaskService({
    repository: store.email,
    gmail: fakeGmailAccess(new FakeMailbox('owner@gmail.com', [LEASE_MESSAGE])),
    vault: memoryVault(),
    provider: scriptedFilingProvider({
      script: async (call) => {
        await call('search_messages', { query: 'lease' });
        await call('propose_reply', { message: 'msg-1', body: 'Yes, by Friday.' });
      },
      turn: { toolsOffered: EMAIL_BROKER_MCP_TOOLS },
    }),
  });
  const personal = new PersonalTaskService({ repository: store.personal, homeDir: dir });
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    ownerPairing,
    store,
    routines: { service: new RoutineService({ repository: store.routines, personal, email }) },
  });
});

afterEach(async () => {
  await email.whenIdle();
  await app.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function workingTask(): Promise<string> {
  const account = await email.connectAccount(OWNER);
  const task = email.submit({ accountId: account.id, request: 'The lease email. Say yes by Friday.' }, OWNER);
  await email.whenIdle();
  const drafted = await email.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
  await email.approveSend(task.id, { version: drafted.drafts[0]!.version, digest: drafted.drafts[0]!.digest }, OWNER);
  return task.id;
}

describe('routine routes', () => {
  it('lets the owner at the Mac save, run, rename, and delete a routine', async () => {
    const taskId = await workingTask();
    const saved = await app.inject({ method: 'POST', url: '/api/personal/routines', headers: LOCAL, payload: { name: 'Answer Pat', source: 'email', taskId } });
    expect(saved.statusCode).toBe(201);
    const routine = saved.json() as RoutineView;

    const ran = await app.inject({ method: 'POST', url: `/api/personal/routines/${routine.id}/run`, headers: LOCAL });
    expect(ran.statusCode).toBe(200);
    const { run } = ran.json() as { run: RoutineRunView; routine: RoutineView };
    expect(run).toMatchObject({ outcome: 'started', task: { source: 'email' } });
    expect(run.task!.id).not.toBe(taskId);
    await email.whenIdle();

    const renamed = await app.inject({ method: 'PATCH', url: `/api/personal/routines/${routine.id}`, headers: LOCAL, payload: { name: 'Lease reply' } });
    expect(renamed.json()).toMatchObject({ name: 'Lease reply' });
    const bad = await app.inject({ method: 'PATCH', url: `/api/personal/routines/${routine.id}`, headers: LOCAL, payload: { grantId: 'g' } });
    expect(bad.statusCode).toBe(400);

    expect((await app.inject({ method: 'DELETE', url: `/api/personal/routines/${routine.id}`, headers: LOCAL })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/personal/routines', headers: LOCAL })).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/personal/routines/${routine.id}/run`, headers: LOCAL })).statusCode).toBe(404);
    expect(email.get(run.task!.id)).toBeDefined();
  });

  it('refuses a collaborator device, the shared token, and a paired owner phone', async () => {
    const taskId = await workingTask();
    const routine = (await app.inject({ method: 'POST', url: '/api/personal/routines', headers: LOCAL, payload: { name: 'Answer Pat', source: 'email', taskId } })).json() as RoutineView;
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
        ['GET', '/api/personal/routines'], ['GET', `/api/personal/routines/${routine.id}`], ['POST', '/api/personal/routines'],
        ['PATCH', `/api/personal/routines/${routine.id}`], ['DELETE', `/api/personal/routines/${routine.id}`], ['POST', `/api/personal/routines/${routine.id}/run`],
      ] as const) {
        const response = await app.inject({ method, url, headers, ...(method === 'POST' || method === 'PATCH' ? { payload: { name: 'x', source: 'email', taskId } } : {}) });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(email.list()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/personal/routines/${routine.id}`, headers: LOCAL })).json()).toMatchObject({ name: 'Answer Pat', runs: [] });
  });
});
