import type { RuntimeReadinessReport } from '../sessions/runtime-readiness-contract.js';
import type { RuntimeReadinessSource } from '../sessions/runtime-readiness.js';

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

/**
 * Ticket 14: the same report with a Claude installation that does satisfy
 * every managed-run capability — what an up-to-date CLI reports, and the
 * only shape under which a Run may select Claude for managed work.
 */
export const managedClaudeRuntimeReadinessReport: RuntimeReadinessReport = {
  checkedAt: runtimeReadinessReportFixture.checkedAt,
  runtimes: runtimeReadinessReportFixture.runtimes.map((runtime) => (runtime.runtime === 'claude'
    ? {
      ...runtime,
      status: 'managed',
      version: '2.1.260',
      reason: 'All managed-run capabilities are available.',
      capabilities: runtime.capabilities.map((capability) => ({ capability: capability.capability, supported: true })),
    }
    : runtime)),
};

/** A RuntimeReadinessSource that resolves to the fixture above (or an override), for tests that need one without spawning real CLI processes. */
export function stubRuntimeReadinessSource(
  report: RuntimeReadinessReport = runtimeReadinessReportFixture,
): RuntimeReadinessSource {
  return { get: async () => report };
}
