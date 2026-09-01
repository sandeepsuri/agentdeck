import type { RuntimeReadinessReport } from '../sessions/runtime-readiness-contract.js';

export const runtimeReadinessReportFixture: RuntimeReadinessReport = {
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
      version: '2.1.251',
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
