// Ticket 11: the wrap-up REST surface. manager.summarize()/readSummary()
// are faked here — this is a routing/validation test, not a re-test of
// SessionManager's own summarize() behavior (see sessions/manager.test.ts)
// or the Summarizer subprocess adapter (see sessions/summarizer.test.ts).
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

const withSummary: Session = { ...endedManaged, id: 'sess-with-summary', summaryGeneratedAt: '2026-08-27T09:10:00.000Z' };

describe('POST /api/sessions/:id/summarize', () => {
  let app: ReturnType<typeof Fastify>;
  let manager: Pick<SessionManager, 'getSession' | 'isLive' | 'summarize' | 'readSummary'>;
  let summarizeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = Fastify();
    summarizeMock = vi.fn(async () => 'a generated summary');
    manager = {
      getSession: vi.fn((id: string) =>
        id === endedManaged.id ? endedManaged
          : id === liveManaged.id ? liveManaged
            : id === externalSession.id ? externalSession
              : id === withSummary.id ? withSummary
                : undefined),
      isLive: vi.fn((id: string) => id === liveManaged.id),
      summarize: summarizeMock,
      readSummary: vi.fn(async (id: string) => (id === withSummary.id ? 'stored summary' : undefined)),
    };
    registerRoutes(app, { manager: manager as SessionManager, config: defaultConfig() });
  });

  afterEach(async () => {
    await app.close();
  });

  it('generates a summary for an ended managed session', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${endedManaged.id}/summarize` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: endedManaged.id, summary: 'a generated summary' });
    expect(summarizeMock).toHaveBeenCalledWith(endedManaged.id, {});
  });

  it('passes an explicit model override through to the manager', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/sessions/${endedManaged.id}/summarize`,
      payload: { model: 'claude-opus-5' },
    });
    expect(response.statusCode).toBe(200);
    expect(summarizeMock).toHaveBeenCalledWith(endedManaged.id, { model: 'claude-opus-5' });
  });

  it('404s for an unknown session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sessions/nope/summarize' });
    expect(response.statusCode).toBe(404);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('400s a live session that has not ended yet', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${liveManaged.id}/summarize` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not ended/);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('400s an external session', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${externalSession.id}/summarize` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/managed/);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('400s a non-string model', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/sessions/${endedManaged.id}/summarize`,
      payload: { model: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('reports a summarizer failure clearly, without a 5xx crash', async () => {
    summarizeMock.mockRejectedValueOnce(new Error('claude -p failed: exit code 1'));
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${endedManaged.id}/summarize` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/claude -p failed/);
  });
});

describe('GET /api/sessions/:id/summary', () => {
  let app: ReturnType<typeof Fastify>;
  let manager: Pick<SessionManager, 'getSession' | 'isLive' | 'summarize' | 'readSummary'>;

  beforeEach(() => {
    app = Fastify();
    manager = {
      getSession: vi.fn((id: string) =>
        id === endedManaged.id ? endedManaged
          : id === externalSession.id ? externalSession
            : id === withSummary.id ? withSummary
              : undefined),
      isLive: vi.fn(() => false),
      summarize: vi.fn(),
      readSummary: vi.fn(async (id: string) => (id === withSummary.id ? 'stored summary' : undefined)),
    };
    registerRoutes(app, { manager: manager as SessionManager, config: defaultConfig() });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the stored summary and its timestamp', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${withSummary.id}/summary` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: withSummary.id, summary: 'stored summary', summaryGeneratedAt: withSummary.summaryGeneratedAt,
    });
  });

  it('404s when no summary has been generated yet', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${endedManaged.id}/summary` });
    expect(response.statusCode).toBe(404);
  });

  it('404s for an unknown session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions/nope/summary' });
    expect(response.statusCode).toBe(404);
  });

  it('400s for an external session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${externalSession.id}/summary` });
    expect(response.statusCode).toBe(400);
  });
});
