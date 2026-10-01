import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { ConversationReader, claudeProjectDirName } from '../sessions/conversation.js';
import type { SessionManager } from '../sessions/manager.js';
import { Store } from '../store/index.js';
import type { Session } from '../types.js';
import { TOKEN_HEADER } from './connection-trust.js';
import { registerRoutes } from './routes.js';
import { MAX_IMAGE_BYTES } from './session-images.js';

const session: Session = {
  id: 'sess-1', origin: 'managed', agent: 'claude', cwd: '/Users/me/app',
  startedAt: '2026-09-27T20:00:00.000Z', lastActivityAt: '2026-09-27T20:00:00.000Z',
  status: 'working', statusSource: 'hook',
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function build(token?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-conv-route-'));
  dirs.push(root);
  const project = path.join(root, claudeProjectDirName(session.cwd));
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'x.jsonl'), JSON.stringify({
    type: 'user', uuid: 'u', timestamp: '2026-09-27T20:00:01Z', message: { content: 'hello agent' },
  }));
  const app = Fastify();
  registerRoutes(app, {
    manager: { getSession: (id: string) => (id === session.id ? session : undefined) } as unknown as SessionManager,
    config: { ...defaultConfig({}), ...(token ? { tailscaleToken: token } : {}) },
    conversations: new ConversationReader({ claude: [root], codex: [] }),
    remoteHosts: ['my-mac.tailnet-1234.ts.net'],
  });
  return app;
}

describe('GET /api/sessions/:id/conversation', () => {
  it('returns the agent transcript as turns on this Mac', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ found: true, turns: [{ role: 'user', text: 'hello agent' }] });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/conversation' })).statusCode).toBe(404);
    await app.close();
  });

  it('is refused on a remote connection, even with the shared token', async () => {
    const token = 'a-real-remote-access-token-0123456789';
    const app = build(token);
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/sess-1/conversation',
      headers: { host: 'my-mac.tailnet-1234.ts.net:4040', [TOKEN_HEADER]: token },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('GET /api/sessions/:id/images/:imageId', () => {
  const png = (size: number) => Buffer.alloc(size, 7);

  function buildWithImage(data: Buffer, shrinkImage?: (image: { data: Buffer }) => Promise<Buffer>, token?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-image-route-'));
    dirs.push(root);
    const project = path.join(root, claudeProjectDirName(session.cwd));
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'x.jsonl'), `${JSON.stringify({
      type: 'user', uuid: 'u', timestamp: '2026-09-27T20:00:01Z', message: { content: 'show me' },
    })}\n${JSON.stringify({
      type: 'user', uuid: 'r', timestamp: '2026-09-27T20:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } },
      ] }] },
    })}`);
    const app = Fastify();
    registerRoutes(app, {
      manager: { getSession: (id: string) => (id === session.id ? session : undefined) } as unknown as SessionManager,
      config: { ...defaultConfig({}), ...(token ? { tailscaleToken: token } : {}) },
      conversations: new ConversationReader({ claude: [root], codex: [] }),
      remoteHosts: ['my-mac.tailnet-1234.ts.net'],
      ...(shrinkImage ? { shrinkImage } : {}),
    });
    return app;
  }

  it('returns a small image as it is, and 404 for one that is not there', async () => {
    const app = buildWithImage(png(100));
    const response = await app.inject({ method: 'GET', url: '/api/sessions/sess-1/images/img-1-0' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mediaType: 'image/png', data: png(100).toString('base64') });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/sess-1/images/img-1-1' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/images/img-1-0' })).statusCode).toBe(404);
    await app.close();
  });

  it('re-encodes an image too large for the relay, and refuses one that will not shrink enough', async () => {
    const sides: number[] = [];
    const shrunk = buildWithImage(png(MAX_IMAGE_BYTES + 1), async () => { sides.push(sides.length); return png(sides.length === 1 ? MAX_IMAGE_BYTES + 1 : 1000); });
    const response = await shrunk.inject({ method: 'GET', url: '/api/sessions/sess-1/images/img-1-0' });
    expect(response.json()).toEqual({ mediaType: 'image/jpeg', data: png(1000).toString('base64') });
    expect(sides).toHaveLength(2);
    await shrunk.close();

    const stubborn = buildWithImage(png(MAX_IMAGE_BYTES + 1), async () => png(MAX_IMAGE_BYTES + 1));
    expect((await stubborn.inject({ method: 'GET', url: '/api/sessions/sess-1/images/img-1-0' })).statusCode).toBe(413);
    await stubborn.close();
  });

  it('is refused on a remote connection with the shared token', async () => {
    const token = 'a-real-remote-access-token-0123456789';
    const app = buildWithImage(png(100), undefined, token);
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/sess-1/images/img-1-0',
      headers: { host: 'my-mac.tailnet-1234.ts.net:4040', [TOKEN_HEADER]: token },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /api/sessions/:id/conversation/answer', () => {
  const question = {
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-27T20:00:02Z', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] }] } }] },
  };

  function buildWithQuestion(options: { live?: boolean; store?: Store } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-answer-route-'));
    dirs.push(root);
    const project = path.join(root, claudeProjectDirName(session.cwd));
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'x.jsonl'), JSON.stringify(question));
    const written: string[] = [];
    const app = Fastify();
    registerRoutes(app, {
      manager: {
        getSession: (id: string) => (id === session.id ? session : undefined),
        isLive: () => options.live ?? true,
        write: (_id: string, data: string) => { written.push(data); },
      } as unknown as SessionManager,
      config: defaultConfig({}),
      conversations: new ConversationReader({ claude: [root], codex: [] }),
      ...(options.store ? { store: options.store } : {}),
    });
    return { app, written };
  }

  it('shows the open question and types the chosen answer into the live session', async () => {
    const { app, written } = buildWithQuestion();
    const view = await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation' });
    expect(view.json().question).toMatchObject({ id: 'toolu_1', delivery: 'menu', canAnswer: true, questions: [{ question: 'Pick a color' }] });

    const answered = await app.inject({
      method: 'POST', url: '/api/sessions/sess-1/conversation/answer', payload: { questionId: 'toolu_1', answers: [{ selected: [1] }] },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({ delivered: 'typed' });
    expect(written).toEqual(['2']);
    await app.close();
  });

  it('refuses a stale question, an invalid answer, and a session AgentDeck cannot type into', async () => {
    const { app, written } = buildWithQuestion();
    const stale = await app.inject({ method: 'POST', url: '/api/sessions/sess-1/conversation/answer', payload: { questionId: 'toolu_0', answers: [{ selected: [0] }] } });
    expect(stale.statusCode).toBe(409);
    const invalid = await app.inject({ method: 'POST', url: '/api/sessions/sess-1/conversation/answer', payload: { questionId: 'toolu_1', answers: [{ selected: [7] }] } });
    expect(invalid.statusCode).toBe(400);
    expect(written).toEqual([]);
    await app.close();

    const ended = buildWithQuestion({ live: false });
    expect((await ended.app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation' })).json().question.canAnswer).toBe(false);
    const refused = await ended.app.inject({ method: 'POST', url: '/api/sessions/sess-1/conversation/answer', payload: { questionId: 'toolu_1', answers: [{ selected: [0] }] } });
    expect(refused.statusCode).toBe(400);
    await ended.app.close();
  });

  it('resolves the question through AgentDeck’s Claude hook when the hook is holding it', async () => {
    const store = new Store(':memory:');
    store.upsertSessionInteraction({
      id: 'interaction-1', sessionId: session.id, provider: 'claude', providerSessionId: 'provider', providerRequestId: 'toolu_1',
      requestedAt: '2026-09-27T20:00:02Z', kind: 'question', question: 'Pick a color',
      choices: ['Red', 'Green', 'Blue'].map((label) => ({ id: label, label, questionId: 'Pick a color' })), allowsFreeText: true,
    });
    const { app, written } = buildWithQuestion({ live: false, store });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/sess-1/conversation' })).json().question.canAnswer).toBe(true);
    const answered = await app.inject({ method: 'POST', url: '/api/sessions/sess-1/conversation/answer', payload: { questionId: 'toolu_1', answers: [{ selected: [2] }] } });
    expect(answered.json()).toEqual({ delivered: 'hook' });
    expect(written).toEqual([]);
    expect(store.getSessionInteraction('interaction-1')).toMatchObject({ status: 'resolved', response: { kind: 'answer', answers: { 'Pick a color': ['Blue'] } } });
    await app.close();
    store.close();
  });
});
