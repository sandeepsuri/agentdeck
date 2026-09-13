import { describe, expect, it, vi } from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { WorkRun, WorkSpec } from '../../work-engine/types.js';
import { lines, runtimeSelectableForManagedRun, saveRepositoryVerificationPolicy, submitWorkRun } from './workSubmission.js';

const spec: WorkSpec = {
  objective: 'Ship the feature',
  acceptanceCriteria: ['All criteria pass'],
  repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
  requestedBaseReference: 'main',
  runtimePreference: ['codex'],
  budget: { maxWallClockMs: 3_600_000, maxModelTurns: 50 },
  verificationIntent: { required: true, commands: ['npm test'] },
  requestedDeliveryResult: 'local-commit',
};

const run: WorkRun = {
  id: 'run-1', taskId: 'task-1', status: 'queued', submittedAt: '2026-09-01T00:00:00.000Z', spec,
  principal: { id: 'local:test', displayName: 'test' },
  preparation: { state: 'pending' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
  attempt: { state: 'idle' },
};

describe('submitWorkRun', () => {
  it('submits the complete intent and returns the queued run', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(run), { status: 201, headers: { 'content-type': 'application/json' } }));
    await expect(submitWorkRun(spec, fetcher)).resolves.toEqual(run);
    expect(fetcher).toHaveBeenCalledWith('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
    });
  });
});

describe('saveRepositoryVerificationPolicy', () => {
  it('saves required gates before a Run is submitted', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ policy: { kind: 'required' } }), { status: 200 }));
    const policy = { kind: 'required' as const, gates: [{ name: 'tests', command: 'npm test' }] };
    await saveRepositoryVerificationPolicy('/repos/example', policy, fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/repos/verification-policy', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId: '/repos/example', policy }),
    });
  });
});

// Ticket 14 AC6/AC8: what an operator can actually pick as a Run's runtime is
// decided by the shared readiness report alone — one rule for every runtime.
function readinessReport(claudeStatus: 'managed' | 'compatibility-only' | 'unavailable'): RuntimeReadinessReport {
  return {
    checkedAt: '2026-09-04T00:00:00.000Z',
    runtimes: [
      { runtime: 'codex', displayName: 'Codex CLI', status: 'managed', reason: 'ok', capabilities: [] },
      { runtime: 'claude', displayName: 'Claude Code', status: claudeStatus, reason: 'why', capabilities: [] },
    ],
  };
}

describe('runtimeSelectableForManagedRun', () => {
  it('allows only a runtime whose installation reports managed readiness', () => {
    expect(runtimeSelectableForManagedRun(readinessReport('managed'), 'claude')).toBe(true);
    expect(runtimeSelectableForManagedRun(readinessReport('compatibility-only'), 'claude')).toBe(false);
    expect(runtimeSelectableForManagedRun(readinessReport('unavailable'), 'claude')).toBe(false);
  });

  it('never blocks a choice on evidence it does not have yet', () => {
    expect(runtimeSelectableForManagedRun(null, 'claude')).toBe(true);
  });
});

describe('lines', () => {
  it('parses one trimmed item per non-empty line', () => {
    expect(lines(' a \n\n b\n')).toEqual(['a', 'b']);
  });
});
