// Phone work: starting and steering coding Sessions and Runs from the paired
// owner phone, through buildApp. The owner may, at the Mac or from the phone;
// a collaborator device and the shared tailnet token get nothing new; every
// phone action is audited before it takes effect.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { Store } from '../store/index.js';
import type { LaunchSpec, Session } from '../types.js';
import type { RunActor, WorkEngine, WorkRun, WorkSpec } from '../work-engine/types.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';
import { SessionScreens } from './session-screen.js';
import { registerWorkRoutes } from './work-routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const SHARED_TOKEN = 'a-real-remote-access-token-0123456789';
const LOCAL = { host: '127.0.0.1:4040' };
const remote = (token: string) => ({ host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token });

let base: string;
let repo: string;
let store: Store;
let ownerPairing: OwnerPairingService;
let collaborators: CollaboratorService;
let app: FastifyInstance;
let sessions: Session[];
let live: Set<string>;
let written: { id: string; data: string }[];
let launched: LaunchSpec[];
let runs: Map<string, WorkRun>;
let engineCalls: { method: string; actor?: RunActor }[];

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1', origin: 'managed', agent: 'claude', cwd: repo, repoId: repo, name: 'Fix flaky test',
    startedAt: '2026-10-01T09:00:00.000Z', lastActivityAt: '2026-10-01T09:05:00.000Z',
    status: 'working', statusSource: 'hook', ...overrides,
  };
}

function fakeEngine(): WorkEngine {
  const update = (id: string, patch: Partial<WorkRun>) => {
    const run = { ...runs.get(id)!, ...patch } as WorkRun;
    runs.set(id, run);
    return run;
  };
  return {
    list: () => [...runs.values()],
    get: (id: string) => runs.get(id),
    submit: async (spec: WorkSpec, actor?: RunActor) => {
      engineCalls.push({ method: 'submit', actor });
      const run = {
        id: `run-${runs.size + 1}`, taskId: `task-${runs.size + 1}`, status: 'queued', spec, submittedAt: '2026-10-01T09:00:00.000Z',
        principal: { id: 'owner', displayName: 'Owner' }, preparation: { state: 'pending' }, envelope: { state: 'pending' },
        verificationPolicy: { state: 'pending' }, attempt: { state: 'idle' },
      } as unknown as WorkRun;
      runs.set(run.id, run);
      return run;
    },
    prepare: async (id: string, actor?: RunActor) => {
      engineCalls.push({ method: 'prepare', actor });
      return update(id, { preparation: { state: 'ready', worktreePath: path.join(base, 'wt'), branch: 'agentdeck/run' } });
    },
    start: async (id: string, actor?: RunActor) => {
      engineCalls.push({ method: 'start', actor });
      return update(id, { status: 'running', attempt: { state: 'running', runtime: 'codex', startedAt: '2026-10-01T09:01:00.000Z', events: [] } });
    },
    cancel: async (id: string, actor?: RunActor) => {
      engineCalls.push({ method: 'cancel', actor });
      return update(id, { status: 'cancelled' });
    },
  } as unknown as WorkEngine;
}

function pairPhone(label = 'Sam’s iPhone'): { credential: string; deviceId: string } {
  const challenge = ownerPairing.create();
  const { nonce, code } = ownerPairing.join(challenge.id, challenge.secret, label);
  ownerPairing.confirmOwner(challenge.id, code);
  ownerPairing.confirmPhone(challenge.id, nonce, code);
  return ownerPairing.collect(challenge.id, nonce)!;
}

function collaboratorToken(): string {
  const { code } = collaborators.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: [repo] });
  return collaborators.exchangeInvitation(code, 'Alice laptop').token;
}

const actions = (deviceId: string) => store.ownerDevices.listAudit(deviceId).map((row) => `${row.action}:${row.targetId}`);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-phone-work-'));
  repo = path.join(base, 'app');
  fs.mkdirSync(repo);
  store = new Store(path.join(base, 'agentdeck.db'));
  store.upsertRepo({ id: repo, path: repo, name: 'app', currentBranch: 'main' });
  ownerPairing = new OwnerPairingService(store.ownerDevices);
  collaborators = new CollaboratorService(store);
  sessions = [session()];
  live = new Set(['sess-1']);
  written = [];
  launched = [];
  runs = new Map();
  engineCalls = [];
  const engine = fakeEngine();
  const manager = {
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((item) => item.id === id),
    isLive: (id: string) => live.has(id),
    write: (id: string, data: string) => { written.push({ id, data }); },
    getTranscript: (id: string) => (live.has(id) ? { snapshot: () => `screen of ${id}\n❯ ` } : undefined),
    readScrollback: async () => 'ended scrollback',
    launch: async (spec: LaunchSpec) => {
      launched.push(spec);
      const started = session({ id: 'sess-new', name: spec.name, startedAt: '2026-10-01T10:00:00.000Z' });
      sessions.push(started);
      return started;
    },
  } as unknown as RouteContext['manager'];
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: SHARED_TOKEN },
    manager,
    store,
    ownerPairing,
    collaborators,
    remoteHosts: [REMOTE_HOST],
    workEngine: engine,
    runtimeReadiness: { get: async () => ({ checkedAt: 'now', runtimes: [] }) },
    sessionScreens: new SessionScreens(
      (id) => (live.has(id) ? { snapshot: () => `screen of ${id}\n❯ ` } : undefined),
      { intervalMs: 20, render: async (bytes) => bytes },
    ),
  });
  // index.ts registers the Run routes beside buildApp, acting as the phone the same way.
  registerWorkRoutes(app, engine, {
    resolveActor: (req) => {
      const device = ownerPairing.resolve(String(req.headers[TOKEN_HEADER] ?? ''));
      return device ? { principal: { id: 'owner', displayName: 'Owner' }, device } : undefined;
    },
  });
});

afterEach(async () => {
  await app.close();
  store.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('who may use phone work', () => {
  it('answers the owner at the Mac and the paired phone, and nobody else', async () => {
    const { credential } = pairPhone();
    expect((await app.inject({ method: 'GET', url: '/api/phone/work', headers: LOCAL })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/phone/work', headers: remote(credential) })).statusCode).toBe(200);
    for (const token of [SHARED_TOKEN, collaboratorToken()]) {
      for (const [method, url] of [
        ['GET', '/api/phone/work'], ['GET', '/api/phone/repos'], ['POST', '/api/phone/sessions'], ['POST', '/api/phone/runs'],
        ['POST', '/api/phone/sessions/sess-1/keys'], ['GET', '/api/sessions/sess-1/conversation'], ['POST', '/api/sessions/sess-1/stop'],
        ['GET', '/api/sessions/sess-1/images/img-2-0'],
      ] as const) {
        expect((await app.inject({ method, url, headers: remote(token), payload: {} })).statusCode, `${method} ${url}`).toBe(403);
      }
    }
  });

  it('keeps the Mac-only launcher, settings, hooks and deleting off the phone', async () => {
    const { credential } = pairPhone();
    for (const [method, url] of [
      ['POST', '/api/sessions'], ['GET', '/api/settings'], ['POST', '/api/hooks/install'], ['DELETE', '/api/sessions/sess-1'],
      ['PUT', '/api/repos/verification-policy'], ['GET', '/api/runs'], ['POST', '/api/repos/file-action'],
    ] as const) {
      expect((await app.inject({ method, url, headers: remote(credential), payload: {} })).statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('the Work list and Needs you', () => {
  it('lists Sessions, Runs and what is waiting, newest first', async () => {
    sessions = [
      session({ agentSessionId: 'claude:provider-session' }),
      session({ id: 'sess-2', name: 'Refactor', status: 'waiting_input', lastActivityAt: '2026-10-01T09:06:00.000Z' }),
    ];
    const ingested = await app.inject({ method: 'POST', url: '/api/provider/claude/interactions', headers: LOCAL, payload: {
      hook_event_name: 'PermissionRequest', session_id: 'provider-session', agentdeck_request_id: 'approval-1', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'npm test' },
    } });
    expect(ingested.statusCode).toBe(201);
    const { credential } = pairPhone();
    const work = (await app.inject({ method: 'GET', url: '/api/phone/work', headers: remote(credential) })).json() as {
      sessions: { id: string; live: boolean; need?: string; repoName: string }[]; needs: { kind: string; sessionId?: string }[];
    };
    expect(work.sessions.map((item) => item.id)).toEqual(['sess-2', 'sess-1']);
    expect(work.sessions[1]).toMatchObject({ live: true, repoName: 'app', need: 'session-approval' });
    expect(work.needs).toContainEqual(expect.objectContaining({ kind: 'session-approval', sessionId: 'sess-1' }));
    expect(work.needs).toContainEqual(expect.objectContaining({ kind: 'session-waiting', sessionId: 'sess-2' }));
    expect(JSON.stringify(work)).not.toContain('launchSpec');
  });
});

describe('Start work from the phone', () => {
  it('starts a Quick session only in a repository the Mac has, marked as from the phone', async () => {
    const { credential, deviceId } = pairPhone();
    const unknown = await app.inject({ method: 'POST', url: '/api/phone/sessions', headers: remote(credential), payload: { repositoryId: '/etc', task: 'x' } });
    expect(unknown.statusCode).toBe(404);

    const started = await app.inject({ method: 'POST', url: '/api/phone/sessions', headers: remote(credential), payload: {
      repositoryId: repo, task: 'Fix the flaky relay test', agent: 'claude', permissionMode: 'acceptEdits',
      // Ignored: the phone cannot set these.
      cwd: '/tmp', env: { SECRET: '1' }, extraArgs: ['--dangerously-skip-permissions'],
    } });
    expect(started.statusCode).toBe(201);
    expect(started.json()).not.toHaveProperty('launchSpec');
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ agent: 'claude', cwd: repo, initialPrompt: 'Fix the flaky relay test', permissionMode: 'acceptEdits' });
    expect(launched[0]).not.toHaveProperty('env');
    expect(launched[0]!.extraArgs).toEqual(['--permission-mode', 'acceptEdits']);
    expect(actions(deviceId)).toContain(`session-start:${repo}`);
    const bus = fs.readFileSync(path.join(repo, '.agents', 'bus.jsonl'), 'utf8');
    expect(JSON.parse(bus.trim().split('\n').at(-1)!)).toMatchObject({ agent: 'dashboard:sess-new', message: 'Fix the flaky relay test', via: 'phone' });
  });

  it('refuses a bad permission mode and an option-looking branch', async () => {
    const { credential } = pairPhone();
    const headers = remote(credential);
    expect((await app.inject({ method: 'POST', url: '/api/phone/sessions', headers, payload: { repositoryId: repo, task: 'x', permissionMode: 'bypassPermissions' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/phone/sessions', headers, payload: { repositoryId: repo, task: 'x', branch: '--force' } })).statusCode).toBe(400);
    expect(launched).toHaveLength(0);
  });

  it('starts a Structured Run with the checks set on the Mac, acting as the phone', async () => {
    const { credential, deviceId } = pairPhone();
    const payload = { repositoryId: repo, objective: 'Add CSV export', acceptanceCriteria: ['Exports rows'], agent: 'codex', wallClockMinutes: 45 };
    const missing = await app.inject({ method: 'POST', url: '/api/phone/runs', headers: remote(credential), payload });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: 'checks-missing' });

    store.setRepositoryVerificationPolicy(repo, { kind: 'required', gates: [{ name: 'test', command: 'npm test' }] });
    const started = await app.inject({ method: 'POST', url: '/api/phone/runs', headers: remote(credential), payload });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ objective: 'Add CSV export', status: 'running', repoName: 'app' });
    expect(engineCalls.map((call) => call.method)).toEqual(['submit', 'prepare', 'start']);
    expect(engineCalls.every((call) => call.actor?.device?.id === deviceId && !call.actor.grants)).toBe(true);
    const spec = [...runs.values()][0]!.spec;
    expect(spec).toMatchObject({ requestedBaseReference: 'main', runtimePreference: ['codex'], budget: { maxWallClockMs: 45 * 60_000 } });
    expect(actions(deviceId)).toContain(`run-submit:${repo}`);

    const detail = await app.inject({ method: 'GET', url: '/api/phone/runs/run-1', headers: remote(credential) });
    expect(detail.json()).toMatchObject({ id: 'run-1', actions: { cancel: true, pause: true }, timeline: [{ label: 'Submitted' }, { label: 'Prepared' }] });

    const cancelled = await app.inject({ method: 'POST', url: '/api/runs/run-1/cancel', headers: remote(credential) });
    expect(cancelled.statusCode).toBe(200);
    expect(actions(deviceId)).toContain('run-control:run-1');
  });
});

describe('steering a live session from the phone', () => {
  it('sends only the fixed control keys, by name, and records it', async () => {
    const { credential, deviceId } = pairPhone();
    const headers = remote(credential);
    expect((await app.inject({ method: 'POST', url: '/api/phone/sessions/sess-1/keys', headers, payload: { keys: ['x'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/phone/sessions/sess-1/keys', headers, payload: { keys: ['\u001b'] } })).statusCode).toBe(400);
    expect(written).toEqual([]);
    const sent = await app.inject({ method: 'POST', url: '/api/phone/sessions/sess-1/keys', headers, payload: { keys: ['Esc', 'Enter'] } });
    expect(sent.statusCode).toBe(200);
    expect(written).toEqual([{ id: 'sess-1', data: '\u001b' }, { id: 'sess-1', data: '\r' }]);
    expect(actions(deviceId)).toContain('session-input:sess-1');
  });

  it('long-polls the terminal text and shows the Mac that the phone is following', async () => {
    const { credential } = pairPhone();
    const first = await app.inject({ method: 'GET', url: '/api/phone/sessions/sess-1/screen?after=-1&wait=1500', headers: remote(credential) });
    expect(first.json()).toMatchObject({ seq: 1, text: 'screen of sess-1\n❯', live: true });
    live.delete('sess-1');
    const ended = await app.inject({ method: 'GET', url: '/api/phone/sessions/sess-1/screen?after=1', headers: remote(credential) });
    expect(ended.json()).toMatchObject({ live: false, text: 'ended scrollback' });

    const mac = await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation', headers: LOCAL });
    expect(mac.json()).toMatchObject({ phoneFollowing: true });
  });

  it('lets the phone read the conversation and stop the session, recording the stop', async () => {
    const { credential, deviceId } = pairPhone();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation', headers: remote(credential) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation', headers: remote(SHARED_TOKEN) })).statusCode).toBe(403);
    // Allowed through to the route, which finds no such image in this fixture.
    expect((await app.inject({ method: 'GET', url: '/api/sessions/sess-1/images/img-2-0', headers: remote(credential) })).statusCode).toBe(404);
    // The fake manager has no stop(); the request is still recorded first.
    await app.inject({ method: 'POST', url: '/api/sessions/sess-1/stop', headers: remote(credential) });
    expect(actions(deviceId)).toContain('session-stop:sess-1');
  });

  it('lets the owner phone approve a tool request that a collaborator may not', async () => {
    sessions = [session({ origin: 'external', agentSessionId: 'claude:provider-session' })];
    const ingested = await app.inject({ method: 'POST', url: '/api/provider/claude/interactions', headers: LOCAL, payload: {
      hook_event_name: 'PermissionRequest', session_id: 'provider-session', agentdeck_request_id: 'approval-1', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'npm test' },
    } });
    expect(ingested.statusCode).toBe(201);
    const id = ingested.json().id as string;
    const { credential, deviceId } = pairPhone();
    const view = await app.inject({ method: 'GET', url: '/api/sessions/sess-1/interactions', headers: remote(credential) });
    expect(view.json()).toMatchObject({ interactions: [{ id, kind: 'approval', canRespond: true }] });
    const approved = await app.inject({ method: 'POST', url: `/api/sessions/sess-1/interactions/${id}/respond`, headers: remote(credential), payload: { decision: 'approve' } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'resolved', responderDisplayName: expect.stringContaining('Sam’s iPhone') });
    expect(actions(deviceId)).toContain('session-respond:sess-1');
  });
});
