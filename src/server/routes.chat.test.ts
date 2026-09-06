// End-to-end coverage for the shared session chat's REST surface
// (docs/specs/shared-session-chat.md): POST/GET /api/sessions/:id/chat, with
// a real device credential the way collaborator-workspace.integration.test.ts
// exercises every other collaborator route. The pure decisions (identity,
// merging) are covered in session-conversation.test.ts; this is the wiring
// between them and persistence/delivery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Session } from '../types.js';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { Store } from '../store/index.js';
import { buildApp } from './app.js';
import { classify, TOKEN_HEADER } from './connection-trust.js';
import type { RouteContext } from './routes.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-repo-'));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ext-1', origin: 'external', agent: 'claude', name: 'Claude on auth',
    repoId: REPO_PATH, cwd: `${REPO_PATH}/packages/api`, branch: 'feat/auth', pid: 4711,
    startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
    status: 'working', statusSource: 'hook', agentSessionId: 'claude:0e655530-853a-4693',
    ...overrides,
  };
}

let store: Store;
afterEach(() => { store.close(); });

function setUp() {
  let sessions: Session[] = [];
  const written: string[] = [];
  store = new Store(':memory:');
  store.upsertRepo({ id: REPO_PATH, name: 'example', path: REPO_PATH });
  const collaborators = new CollaboratorService(store);
  const app = buildApp({
    config: { ...defaultConfig(), projectsDir: '/nonexistent/agentdeck-chat-projects' },
    manager: {
      listSessions: () => sessions,
      getSession: (idToFind: string) => sessions.find((item) => item.id === idToFind),
      isLive: () => true,
      write: (_id: string, text: string) => { written.push(text); },
    } as unknown as RouteContext['manager'],
    store,
    remoteHosts: [REMOTE_HOST],
    collaborators,
  });
  const requestTrust = (req: FastifyRequest) => classify(
    { host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER] as string | undefined },
    { remoteHosts: [REMOTE_HOST], deviceLookup: collaborators.resolveDevice },
  );
  const { code } = collaborators.inviteCollaborator({
    displayName: 'Alice', grantedRepositoryIds: [REPO_PATH], grantedProfileIds: [],
  });
  const { token: aliceToken } = collaborators.exchangeInvitation(code, "Alice's phone");
  const { code: bobCode } = collaborators.inviteCollaborator({
    displayName: 'Bob', grantedRepositoryIds: [REPO_PATH], grantedProfileIds: [],
  });
  const { token: bobToken } = collaborators.exchangeInvitation(bobCode, "Bob's laptop");
  return {
    app, aliceToken, bobToken, requestTrust, written, setSessions: (next: Session[]) => { sessions = next; },
  };
}

const asHeaders = (token: string) => ({ host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token, 'content-type': 'application/json' });

describe('POST /api/sessions/:id/chat', () => {
  it('posts ordinary chat, attributed to the real sender, and never touches the agent', async () => {
    const { app, aliceToken, written, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: 'Can you review the code?' }),
    });

    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({
      displayName: 'Alice', text: 'Can you review the code?', audience: 'chat',
    });
    expect(posted.json()).not.toHaveProperty('delivery');
    expect(written).toEqual([]);
    await app.close();
  });

  it('delivers an @agent-addressed message to a managed session’s PTY, with sender attribution attached', async () => {
    const { app, aliceToken, written, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: '@agent can you review the code?' }),
    });

    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({
      displayName: 'Alice', text: '@agent can you review the code?', audience: 'agent', delivery: 'sent',
    });
    expect(written).toEqual(['Alice: can you review the code?']);
    await app.close();
  });

  it('queues an @agent-addressed message for an external Claude session through the hook inbox', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session({ terminalApp: 'VSCode' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: '@agent, please review' }),
    });

    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ audience: 'agent', delivery: 'queued' });
    const inbox = await fs.promises.readFile(path.join(REPO_PATH, '.agents', 'inbox.jsonl'), 'utf8');
    expect(inbox).toContain('Alice: please review');
    await app.close();
  });

  it('rejects a mention with nothing left to ask, persisting nothing', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: '@agent' }),
    });

    expect(posted.statusCode).toBe(400);
    expect(posted.json()).toEqual({ error: 'Add a message for the agent.' });
    const read = await app.inject({ method: 'GET', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken) });
    expect(read.json()).toEqual([]);
    await app.close();
  });

  it('reports a definite failure, with a reason, rather than silently dropping an @agent post to a finished session', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session({ status: 'exited' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: '@agent are you still there?' }),
    });

    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ audience: 'agent', delivery: 'not_sent' });
    expect((posted.json() as { deliveryReason: string }).deliveryReason).toBeTruthy();
    await app.close();
  });

  it('still allows plain chat after the runtime has exited', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session({ status: 'exited' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: 'well, that happened' }),
    });

    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ audience: 'chat' });
    await app.close();
  });

  it('is refused a raw control byte even in the chat composer', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: 'stop' }),
    });

    expect(posted.statusCode).toBe(400);
    await app.close();
  });

  it('is refused a Session outside its grant, exactly like every other collaborator route', async () => {
    const { app, aliceToken } = setUp();
    // No sessions granted/visible at all — same 404-not-403 behaviour as /send.
    const posted = await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: 'hello' }),
    });

    expect(posted.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/sessions/:id/chat', () => {
  it('shows two collaborators their own names, never collapsed into "human"', async () => {
    const { app, aliceToken, bobToken, setSessions } = setUp();
    setSessions([session({ origin: 'managed' })]);

    await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken),
      payload: JSON.stringify({ text: 'Any progress?' }),
    });
    await app.inject({
      method: 'POST', url: '/api/sessions/ext-1/chat', headers: asHeaders(bobToken),
      payload: JSON.stringify({ text: 'Checking now' }),
    });

    const read = await app.inject({ method: 'GET', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken) });

    expect(read.statusCode).toBe(200);
    const messages = read.json() as { displayName: string; text: string }[];
    expect(messages.map((m) => `${m.displayName}: ${m.text}`)).toEqual([
      'Alice: Any progress?', 'Bob: Checking now',
    ]);
    await app.close();
  });

  it('merges the agent’s own bus turns into the same feed, with this Repository’s paths rewritten out', async () => {
    const { app, aliceToken, setSessions } = setUp();
    setSessions([session()]);
    await fs.promises.mkdir(path.join(REPO_PATH, '.agents'), { recursive: true });
    await fs.promises.writeFile(path.join(REPO_PATH, '.agents', 'bus.jsonl'), `${JSON.stringify({
      ts: '2026-09-01T00:02:00.000Z', agent: 'claude:0e655530-853a-4693', repo: REPO_PATH,
      event: 'message', message: `Patched ${REPO_PATH}/src/auth.ts`, sessionId: 'ext-1',
    })}\n`);

    const read = await app.inject({ method: 'GET', url: '/api/sessions/ext-1/chat', headers: asHeaders(aliceToken) });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual([
      { id: 'agent:2026-09-01T00:02:00.000Z', ts: '2026-09-01T00:02:00.000Z', authorKind: 'agent', displayName: 'Claude Code', text: 'Patched ./src/auth.ts', event: 'message' },
    ]);
    expect(read.body).not.toContain(REPO_PATH);
    await app.close();
  });
});
