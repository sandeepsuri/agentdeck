import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../types.js';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { Store } from '../store/index.js';
import { buildApp } from './app.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet.ts.net';
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-interactions-'));
const baseSession: Session = {
  id: 'session-1', origin: 'external', agent: 'claude', cwd: repo, repoId: repo,
  agentSessionId: 'claude:provider-session', status: 'working', statusSource: 'hook',
  startedAt: '2026-09-10T12:00:00.000Z', lastActivityAt: '2026-09-10T12:00:00.000Z',
};
let store: Store | undefined;

afterEach(() => { store?.close(); store = undefined; });

function setUp(session = baseSession) {
  store = new Store(':memory:');
  store.upsertRepo({ id: repo, path: repo, name: 'example' });
  const collaborators = new CollaboratorService(store);
  const invite = (name: string) => {
    const { code } = collaborators.inviteCollaborator({ displayName: name, grantedRepositoryIds: [repo] });
    return collaborators.exchangeInvitation(code, `${name} device`).token;
  };
  const app = buildApp({
    config: defaultConfig(), store, collaborators, remoteHosts: [REMOTE_HOST],
    manager: {
      listSessions: () => [session], getSession: (id: string) => id === session.id ? session : undefined,
      isLive: () => false,
    } as unknown as RouteContext['manager'],
  });
  return { app, alice: invite('Alice'), bob: invite('Bob') };
}

const headers = (token: string) => ({ host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' });
const questionPayload = {
  hook_event_name: 'PreToolUse', session_id: 'provider-session', tool_use_id: 'question-1', cwd: repo,
  tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which package manager?', header: 'Package manager',
    options: [{ label: 'npm' }, { label: 'pnpm' }], multiSelect: false }] },
};

describe('shared Session interactions routes', () => {
  it('continues the same Claude Session after a collaborator answers its exact question', async () => {
    const { app, alice } = setUp();
    const ingested = await app.inject({ method: 'POST', url: '/api/provider/claude/interactions', headers: { host: 'localhost:4040' }, payload: questionPayload });
    expect(ingested.statusCode).toBe(201);
    const id = ingested.json().id as string;
    const view = await app.inject({ url: '/api/sessions/session-1/interactions', headers: headers(alice) });
    expect(view.json()).toMatchObject({ processingState: 'waiting_answer', interactions: [{ id, canRespond: true, question: 'Which package manager?' }] });
    expect(view.body).not.toContain('provider-session');
    expect(view.body).not.toContain('question-1');

    const answered = await app.inject({ method: 'POST', url: `/api/sessions/session-1/interactions/${id}/respond`, headers: headers(alice), payload: { answers: { 'Which package manager?': ['pnpm'] } } });
    expect(answered.statusCode).toBe(200);
    expect(answered.body).not.toContain('provider-session');
    expect(answered.body).not.toContain('question-1');
    const pendingDelivery = await app.inject({ url: '/api/sessions/session-1/interactions', headers: headers(alice) });
    expect(pendingDelivery.json().processingState).toBe('delivery_pending');
    const provider = await app.inject({ url: `/api/provider/claude/interactions/${id}`, headers: { host: 'localhost:4040' } });
    expect(provider.json()).toEqual({ status: 'resolved', response: { kind: 'answer', answers: { 'Which package manager?': ['pnpm'] } } });
    expect((await app.inject({ method: 'POST', url: `/api/provider/claude/interactions/${id}/acknowledge`, headers: { host: 'localhost:4040' } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/sessions/session-1/interactions', headers: headers(alice) })).json().processingState).toBe('working');
    expect(baseSession.id).toBe('session-1');
    await app.close();
  });

  it('keeps approvals admin-only and rejects the second participant as stale', async () => {
    const { app, alice, bob } = setUp();
    const ingested = await app.inject({ method: 'POST', url: '/api/provider/claude/interactions', headers: { host: 'localhost:4040' }, payload: {
      hook_event_name: 'PermissionRequest', session_id: 'provider-session', agentdeck_request_id: 'approval-1', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'npm test' },
    } });
    const id = ingested.json().id as string;
    const unauthorized = await app.inject({ method: 'POST', url: `/api/sessions/session-1/interactions/${id}/respond`, headers: headers(alice), payload: { decision: 'approve' } });
    expect(unauthorized.statusCode).toBe(403);
    expect(unauthorized.json().error).toContain('local admin');
    const approved = await app.inject({ method: 'POST', url: `/api/sessions/session-1/interactions/${id}/respond`, headers: { host: 'localhost:4040' }, payload: { decision: 'deny' } });
    expect(approved.statusCode).toBe(200);
    const stale = await app.inject({ method: 'POST', url: `/api/sessions/session-1/interactions/${id}/respond`, headers: headers(bob), payload: { decision: 'deny' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().interaction.responderDisplayName).not.toBe('Bob');
    await app.close();
  });

  it('reports Codex interactive Session requests as unsupported', async () => {
    const { app, alice } = setUp({ ...baseSession, agent: 'codex', agentSessionId: 'codex:thread' });
    const view = await app.inject({ url: '/api/sessions/session-1/interactions', headers: headers(alice) });
    expect(view.json()).toMatchObject({ providerSupport: 'unavailable', providerReason: expect.stringContaining('Codex notify') });
    await app.close();
  });
});
