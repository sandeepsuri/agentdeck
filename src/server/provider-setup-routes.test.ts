// Issue #85: the provider setup REST surface, through buildApp so the same
// onRequest gate and classify() call decide who is the owner at this Mac.
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { ProviderSetupService, type ProviderSetupView } from '../provider-setup/service.js';
import { Store } from '../store/index.js';
import { FakeCommands, SIGNED_OUT } from '../test-fixtures/provider-commands.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };

let store: Store;
let commands: FakeCommands;
let service: ProviderSetupService;
let collaborators: CollaboratorService;
let app: FastifyInstance;

beforeEach(() => {
  store = new Store(':memory:');
  commands = new FakeCommands();
  service = new ProviderSetupService({ repository: store.providerReadiness, commands });
  collaborators = new CollaboratorService(store);
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    store,
    providerSetup: service,
  });
});

afterEach(async () => {
  service.shutdown();
  await service.whenIdle();
  await app.close();
  store.close();
});

const claude = (view: ProviderSetupView) => view.providers.find((entry) => entry.provider === 'claude')!;

describe('owner at this Mac', () => {
  it('checks every provider once on first load, then reports readiness and repair steps', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/provider-setup', headers: LOCAL });
    expect(first.statusCode).toBe(200);
    await service.whenIdle();
    const view = (await app.inject({ method: 'GET', url: '/api/provider-setup', headers: LOCAL })).json() as ProviderSetupView;
    expect(claude(view)).toMatchObject({ confirmedThisLaunch: true, readiness: { state: 'ready' } });
    expect(view.providers.find((entry) => entry.provider === 'codex')).toMatchObject({
      readiness: { state: 'missing-cli' }, repair: { actions: ['open-install-guide', 'check'] },
    });
    expect(commands.runs.filter((args) => args[0] === 'auth')).toHaveLength(1);
  });

  it('signs in through the provider CLI, accepts the fallback code, and never echoes it', async () => {
    commands.authStatus = { exitCode: 1, stdout: SIGNED_OUT };
    const started = await app.inject({ method: 'POST', url: '/api/provider-setup/claude/sign-in', headers: LOCAL });
    expect(claude(started.json() as ProviderSetupView).operation).toMatchObject({ kind: 'sign-in', state: 'running' });
    commands.processes[0]!.print('visit: https://claude.com/cai/oauth/authorize?x=1\nPaste code here if prompted > ');

    const code = await app.inject({ method: 'POST', url: '/api/provider-setup/claude/sign-in/code', headers: LOCAL, payload: { code: 'abcdef123456' } });
    expect(code.statusCode).toBe(200);
    expect(code.body).not.toContain('abcdef123456');
    expect(commands.processes[0]!.written).toEqual(['abcdef123456\n']);

    const page = await app.inject({ method: 'POST', url: '/api/provider-setup/claude/sign-in/page', headers: LOCAL });
    expect(page.statusCode).toBe(200);
    expect(commands.opened).toEqual(['https://claude.com/cai/oauth/authorize?x=1']);

    const again = await app.inject({ method: 'POST', url: '/api/provider-setup/claude/sign-in', headers: LOCAL });
    expect(again.statusCode).toBe(409);
  });

  it('refuses an unknown provider and an installer for a provider installed from its own page', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/provider-setup/gemini/check', headers: LOCAL })).statusCode).toBe(404);
    const codex = await app.inject({ method: 'POST', url: '/api/provider-setup/codex/install', headers: LOCAL });
    expect(codex.statusCode).toBe(400);
    expect(commands.processes).toHaveLength(0);
  });
});

describe('everyone else', () => {
  it('a collaborator device or the shared tailnet token can neither read nor drive provider setup', async () => {
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { token } = collaborators.exchangeInvitation(code, 'phone');
    const requests = [
      { method: 'GET' as const, url: '/api/provider-setup' },
      ...['check', 'install', 'install-guide', 'sign-in', 'sign-in/page', 'cancel'].map((action) => ({ method: 'POST' as const, url: `/api/provider-setup/claude/${action}` })),
      { method: 'POST' as const, url: '/api/provider-setup/claude/sign-in/code', payload: { code: 'abcdef123456' } },
    ];
    for (const credential of [token, SHARED_TOKEN]) {
      for (const request of requests) {
        const response = await app.inject({ ...request, headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: credential } });
        expect(response.statusCode, request.url).toBe(403);
      }
    }
    expect(commands.runs).toEqual([]);
    expect(commands.processes).toEqual([]);
    expect(commands.opened).toEqual([]);
  });
});
