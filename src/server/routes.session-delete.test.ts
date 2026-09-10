// Deleting a session from history is managed-only and live-only-blocked —
// see SessionManager.deleteSession's own doc comment for why (the process
// would keep writing to a directory this just deleted).
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { Session } from '../types.js';
import type { SessionManager } from '../sessions/manager.js';
import { registerRoutes } from './routes.js';

const endedManagedSession: Session = {
  id: 'sess-ended', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T09:05:00.000Z',
};

const liveManagedSession: Session = {
  id: 'sess-live', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'working', statusSource: 'output_heuristic',
};

const endedExternalSession: Session = {
  id: 'sess-external', origin: 'external', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T09:05:00.000Z',
};

describe('DELETE /api/sessions/:id', () => {
  let app: ReturnType<typeof Fastify>;
  let manager: Pick<SessionManager, 'getSession' | 'isLive' | 'deleteSession'>;

  beforeEach(() => {
    app = Fastify();
    manager = {
      getSession: vi.fn((id: string) => (
        id === endedManagedSession.id ? endedManagedSession
          : id === liveManagedSession.id ? liveManagedSession
            : id === endedExternalSession.id ? endedExternalSession
              : undefined
      )),
      isLive: vi.fn((id: string) => id === liveManagedSession.id),
      deleteSession: vi.fn(async () => undefined),
    };
    registerRoutes(app, { manager: manager as SessionManager, config: defaultConfig() });
  });

  afterEach(async () => {
    await app.close();
  });

  it('deletes an ended managed session', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/sessions/${endedManagedSession.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(manager.deleteSession).toHaveBeenCalledWith(endedManagedSession.id);
  });

  it('refuses to delete a still-live session, never calling deleteSession', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/sessions/${liveManagedSession.id}` });
    expect(response.statusCode).toBe(400);
    expect(manager.deleteSession).not.toHaveBeenCalled();
  });

  it('refuses to delete an external session', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/sessions/${endedExternalSession.id}` });
    expect(response.statusCode).toBe(400);
    expect(manager.deleteSession).not.toHaveBeenCalled();
  });

  it('404s for an unknown session', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/nope' });
    expect(response.statusCode).toBe(404);
    expect(manager.deleteSession).not.toHaveBeenCalled();
  });

  it('surfaces a deletion failure as 400 without crashing the route', async () => {
    manager.deleteSession = vi.fn(async () => { throw new Error('disk is full'); });
    const response = await app.inject({ method: 'DELETE', url: `/api/sessions/${endedManagedSession.id}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'disk is full' });
  });
});
