// Issue #80: the personal-task REST surface, exercised through buildApp so
// the same onRequest gate and classify() call that protect every other route
// decide who counts as the owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { PersonalTaskService } from '../personal-tasks/service.js';
import type { FolderGrantView, PersonalTaskView } from '../personal-tasks/types.js';
import { Store } from '../store/index.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 3 >>\nendobj\n%%EOF\n';
const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };

let base: string;
let home: string;
let folder: string;
let dbFile: string;
let store: Store;
let collaborators: CollaboratorService;
let service: PersonalTaskService;
let app: FastifyInstance;
let picked: string | undefined;

function write(file: string, content = PDF): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function boot(): void {
  store = new Store(dbFile);
  collaborators = new CollaboratorService(store);
  service = new PersonalTaskService({ repository: store.personal, homeDir: home });
  service.recover();
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    store,
    personalTasks: { service, pickFolder: async () => picked },
  });
}

async function shutdown(): Promise<void> {
  await service.whenIdle();
  await app.close();
  store.close();
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-personal-routes-')));
  home = path.join(base, 'home');
  folder = path.join(home, 'Documents', 'Statements');
  dbFile = path.join(base, 'agentdeck.db');
  write(path.join(folder, 'january.pdf'));
  write(path.join(folder, 'february.pdf'));
  write(path.join(folder, 'readme.txt'), 'text');
  write(path.join(home, 'Private', 'secret.pdf'));
  picked = folder;
  boot();
});

afterEach(async () => {
  await shutdown();
  fs.rmSync(base, { recursive: true, force: true });
});

async function pickGrant(): Promise<FolderGrantView> {
  const response = await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL });
  expect(response.statusCode).toBe(201);
  return (response.json() as { grant: FolderGrantView }).grant;
}

async function submit(grantId: string, files: unknown) {
  return app.inject({ method: 'POST', url: '/api/personal/tasks', headers: LOCAL, payload: { kind: 'pdf-inventory', grantId, files } });
}

describe('owner flow on this Mac', () => {
  it('grants a picked folder, lists its PDFs, inventories selected ones, and reopens the result after restart', async () => {
    const grant = await pickGrant();
    expect(grant).toMatchObject({ name: 'Statements', displayPath: '~/Documents/Statements' });

    const listing = await app.inject({ method: 'GET', url: `/api/personal/grants/${grant.id}/pdfs`, headers: LOCAL });
    expect(listing.json()).toEqual({
      files: [
        { relativePath: 'february.pdf', size: PDF.length, modifiedAt: expect.any(String) },
        { relativePath: 'january.pdf', size: PDF.length, modifiedAt: expect.any(String) },
      ],
      truncated: false,
    });

    const created = await submit(grant.id, ['january.pdf']);
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as PersonalTaskView;
    await service.whenIdle();

    const done = (await app.inject({ method: 'GET', url: `/api/personal/tasks/${id}`, headers: LOCAL })).json() as PersonalTaskView;
    expect(done).toMatchObject({ status: 'completed', result: { knownPages: 3, files: [{ name: 'january.pdf', pageCount: 3 }] } });

    await shutdown();
    boot();
    const reopened = (await app.inject({ method: 'GET', url: '/api/personal/tasks', headers: LOCAL })).json() as PersonalTaskView[];
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toEqual(done);
  });

  it('never returns the absolute folder path', async () => {
    const grant = await pickGrant();
    await submit(grant.id, ['january.pdf']);
    await service.whenIdle();
    for (const url of ['/api/personal/grants', '/api/personal/tasks', `/api/personal/grants/${grant.id}/pdfs`]) {
      const body = (await app.inject({ method: 'GET', url, headers: LOCAL })).body;
      expect(body).not.toContain(base);
    }
  });

  it('treats a cancelled picker as no grant, and refuses a folder that is too broad', async () => {
    picked = undefined;
    const cancelled = await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ cancelled: true });

    picked = home;
    const broad = await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL });
    expect(broad.statusCode).toBe(400);
    expect(broad.json()).toMatchObject({ code: 'too-broad' });
    expect((await app.inject({ method: 'GET', url: '/api/personal/grants', headers: LOCAL })).json()).toEqual([]);
  });

  it('rejects out-of-root paths, symlink escapes, and unsupported files', async () => {
    const grant = await pickGrant();
    fs.symlinkSync(path.join(home, 'Private', 'secret.pdf'), path.join(folder, 'shortcut.pdf'));
    const cases: [unknown, number, string][] = [
      [['../../Private/secret.pdf'], 400, 'outside-grant'],
      [['shortcut.pdf'], 400, 'symlink'],
      [['readme.txt'], 400, 'unsupported-type'],
      ['january.pdf', 400, 'invalid-input'],
    ];
    for (const [files, status, code] of cases) {
      const response = await submit(grant.id, files);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    }
    expect((await submit('no-such-grant', ['january.pdf'])).statusCode).toBe(404);
    const wrongKind = await app.inject({ method: 'POST', url: '/api/personal/tasks', headers: LOCAL, payload: { kind: 'move-files', grantId: grant.id, files: ['january.pdf'] } });
    expect(wrongKind.statusCode).toBe(400);
  });

  it('revocation blocks listing and new tasks', async () => {
    const grant = await pickGrant();
    const revoked = await app.inject({ method: 'POST', url: `/api/personal/grants/${grant.id}/revoke`, headers: LOCAL });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ grant: { id: grant.id, revokedAt: expect.any(String) } });
    expect((await app.inject({ method: 'GET', url: `/api/personal/grants/${grant.id}/pdfs`, headers: LOCAL })).statusCode).toBe(409);
    expect((await submit(grant.id, ['january.pdf'])).json()).toMatchObject({ code: 'grant-revoked' });
    expect((await app.inject({ method: 'POST', url: '/api/personal/grants/missing/revoke', headers: LOCAL })).statusCode).toBe(404);
  });

  it('retries a failed task under the same id', async () => {
    const grant = await pickGrant();
    const { id } = (await submit(grant.id, ['january.pdf'])).json() as PersonalTaskView;
    fs.renameSync(folder, `${folder}-away`);
    await service.whenIdle();
    fs.renameSync(`${folder}-away`, folder);
    const retried = await app.inject({ method: 'POST', url: `/api/personal/tasks/${id}/retry`, headers: LOCAL });
    expect(retried.statusCode).toBe(200);
    await service.whenIdle();
    const task = (await app.inject({ method: 'GET', url: `/api/personal/tasks/${id}`, headers: LOCAL })).json() as PersonalTaskView;
    expect(task.status).toBe('completed');
    expect(task.attempts).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/api/personal/tasks/${id}/retry`, headers: LOCAL })).statusCode).toBe(409);
  });
});

describe('everyone else', () => {
  it('a collaborator device can neither read nor submit owner personal work', async () => {
    const grant = await pickGrant();
    const { id } = (await submit(grant.id, ['january.pdf'])).json() as PersonalTaskView;
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    const remote = { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token };
    const requests = [
      { method: 'GET' as const, url: '/api/personal/tasks' },
      { method: 'GET' as const, url: `/api/personal/tasks/${id}` },
      { method: 'GET' as const, url: '/api/personal/grants' },
      { method: 'GET' as const, url: `/api/personal/grants/${grant.id}/pdfs` },
      { method: 'POST' as const, url: '/api/personal/tasks', payload: { kind: 'pdf-inventory', grantId: grant.id, files: ['january.pdf'] } },
      { method: 'POST' as const, url: '/api/personal/grants/pick' },
      { method: 'POST' as const, url: `/api/personal/grants/${grant.id}/revoke` },
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: remote });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.body).not.toContain('january');
    }
    // The shared tailnet token is not the owner at this Mac either.
    const shared = await app.inject({ method: 'GET', url: '/api/personal/tasks', headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: SHARED_TOKEN } });
    expect(shared.statusCode).toBe(403);
    await service.whenIdle();
    expect(service.list()).toHaveLength(1);
    expect(service.get(id)!.grant.revoked).toBe(false);
  });
});
