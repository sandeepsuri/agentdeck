// Ticket 04: stopping only makes sense for a live managed session. Once a
// session has ended (SessionManager.handleExit already flipped it to
// 'exited' and there is no live PTY behind it), /stop must refuse rather
// than silently no-op.
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { Session } from '../types.js';
import type { SessionManager } from '../sessions/manager.js';
import { registerRoutes } from './routes.js';

const endedSession: Session = {
  id: 'sess-ended', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T09:05:00.000Z',
};

const liveSession: Session = {
  id: 'sess-live', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'working', statusSource: 'output_heuristic',
};

describe('POST /api/sessions/:id/stop', () => {
  let app: ReturnType<typeof Fastify>;
  let manager: Pick<SessionManager, 'getSession' | 'isLive' | 'stop'>;

  beforeEach(() => {
    app = Fastify();
    manager = {
      getSession: vi.fn((id: string) => (id === endedSession.id ? endedSession : id === liveSession.id ? liveSession : undefined)),
      isLive: vi.fn((id: string) => id === liveSession.id),
      stop: vi.fn(async () => undefined),
    };
    registerRoutes(app, { manager: manager as SessionManager, config: defaultConfig() });
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses to stop a session that has already ended', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${endedSession.id}/stop` });
    expect(response.statusCode).toBe(400);
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it('stops a live session', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${liveSession.id}/stop` });
    expect(response.statusCode).toBe(200);
    expect(manager.stop).toHaveBeenCalledWith(liveSession.id);
  });

  it('404s for an unknown session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sessions/nope/stop' });
    expect(response.statusCode).toBe(404);
  });
});
