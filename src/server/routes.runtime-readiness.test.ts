import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { RuntimeReadinessReport } from '../sessions/runtime-readiness.js';
import type { Session } from '../types.js';
import { registerRoutes, type RouteContext } from './routes.js';

const report: RuntimeReadinessReport = {
  checkedAt: '2026-09-01T14:00:00.000Z',
  runtimes: [
    {
      runtime: 'codex',
      displayName: 'Codex CLI',
      status: 'managed',
      version: '0.152.0',
      reason: 'All managed-run capabilities are available.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        { capability: 'execution-restrictions', supported: true },
      ],
    },
    {
      runtime: 'claude',
      displayName: 'Claude Code',
      status: 'compatibility-only',
      version: '2.0.0',
      reason: 'Missing managed-run capabilities: execution restrictions.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        {
          capability: 'execution-restrictions',
          supported: false,
          reason: 'The installed CLI does not expose restricted execution controls.',
        },
      ],
    },
  ],
};

describe('GET /api/runtime-readiness', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reports Codex and Claude independently through the typed public contract', async () => {
    const app = Fastify();
    apps.push(app);
    registerRoutes(app, {
      manager: {} as RouteContext['manager'],
      config: defaultConfig(),
      runtimeReadiness: { get: async () => report },
    });

    const response = await app.inject({ method: 'GET', url: '/api/runtime-readiness' });

    expect({ statusCode: response.statusCode, body: response.json() }).toEqual({
      statusCode: 200,
      body: report,
    });
  });

  it('strips private probe fields from the public response', async () => {
    const app = Fastify();
    apps.push(app);
    const privateReport = {
      ...report,
      authenticationMaterial: 'sk-private',
      runtimes: report.runtimes.map((runtime) => ({
        ...runtime,
        executablePath: `/private/${runtime.runtime}`,
        providerConfiguration: 'hidden-provider-config',
      })),
    };
    registerRoutes(app, {
      manager: {} as RouteContext['manager'],
      config: defaultConfig(),
      runtimeReadiness: { get: async () => privateReport },
    });

    const response = await app.inject({ method: 'GET', url: '/api/runtime-readiness' });

    expect({ body: response.json(), hasPrivateMaterial: /sk-private|\/private\/|hidden-provider-config/.test(response.body) })
      .toEqual({ body: report, hasPrivateMaterial: false });
  });

  it('does not gate existing Session launch when managed-Run readiness is unavailable', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-readiness-launch-'));
    tempDirectories.push(cwd);
    const session: Session = {
      id: 'managed-session',
      origin: 'managed',
      agent: 'codex',
      cwd,
      status: 'starting',
      statusSource: 'output_heuristic',
      startedAt: '2026-09-01T14:00:00.000Z',
      lastActivityAt: '2026-09-01T14:00:00.000Z',
    };
    const launch = vi.fn(async () => session);
    const app = Fastify();
    apps.push(app);
    registerRoutes(app, {
      manager: { launch } as unknown as RouteContext['manager'],
      config: defaultConfig(),
      runtimeReadiness: {
        get: async () => ({
          checkedAt: '2026-09-01T14:00:00.000Z',
          runtimes: report.runtimes.map((runtime) => ({
            runtime: runtime.runtime,
            displayName: runtime.displayName,
            status: 'unavailable' as const,
            reason: `${runtime.displayName} is not installed or is not executable.`,
            capabilities: [],
          })),
        }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { agent: 'codex', cwd },
    });

    expect({ statusCode: response.statusCode, launched: launch.mock.calls.length }).toEqual({
      statusCode: 201,
      launched: 1,
    });
  });
});
