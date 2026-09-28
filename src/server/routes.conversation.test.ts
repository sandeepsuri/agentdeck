import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { ConversationReader, claudeProjectDirName } from '../sessions/conversation.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Session } from '../types.js';
import { TOKEN_HEADER } from './connection-trust.js';
import { registerRoutes } from './routes.js';

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
