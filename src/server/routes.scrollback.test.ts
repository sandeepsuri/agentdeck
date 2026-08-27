// Ticket 09: reopening an ended managed session must show its scrollback.
// There is no WS path for this (attach/replay only serve a live transcript
// snapshot, and an ended session has none) — this REST endpoint reads
// SessionTranscript's stored scrollback.txt instead.
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { Session } from '../types.js';
import type { SessionManager } from '../sessions/manager.js';
import { registerRoutes } from './routes.js';

const endedManaged: Session = {
  id: 'sess-ended', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T09:05:00.000Z',
};

const liveManaged: Session = {
  id: 'sess-live', origin: 'managed', agent: 'claude', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'working', statusSource: 'output_heuristic',
};

const externalSession: Session = {
  id: 'sess-external', origin: 'external', agent: 'codex', cwd: '/repo',
  startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
  status: 'idle', statusSource: 'cpu_heuristic',
};

describe('GET /api/sessions/:id/scrollback', () => {
  let app: ReturnType<typeof Fastify>;
  let manager: Pick<SessionManager, 'getSession' | 'isLive' | 'readScrollback'>;

  beforeEach(() => {
    app = Fastify();
    manager = {
      getSession: vi.fn((id: string) =>
        id === endedManaged.id ? endedManaged
          : id === liveManaged.id ? liveManaged
            : id === externalSession.id ? externalSession
              : undefined),
      isLive: vi.fn((id: string) => id === liveManaged.id),
      readScrollback: vi.fn(async (id: string) => (id === endedManaged.id ? 'line one\nline two' : undefined)),
    };
    registerRoutes(app, { manager: manager as SessionManager, config: defaultConfig() });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the stored scrollback for an ended managed session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${endedManaged.id}/scrollback` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: endedManaged.id, scrollback: 'line one\nline two' });
  });

  it('404s for an unknown session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions/nope/scrollback' });
    expect(response.statusCode).toBe(404);
  });

  it('400s for an external session (history is managed-only per spec)', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${externalSession.id}/scrollback` });
    expect(response.statusCode).toBe(400);
  });

  it('404s a live managed session that has not been compacted yet, and says so', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${liveManaged.id}/scrollback` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/still running/);
  });
});
