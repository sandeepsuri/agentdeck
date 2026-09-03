import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkRun, WorkSpec } from '../../work-engine/types.js';
import { RunSubmissionModal, saveRepositoryVerificationPolicy, submitWorkRun } from './RunSubmissionModal.js';

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
  preparation: { state: 'pending' },
  envelope: { state: 'pending' },
  verificationPolicy: { state: 'pending' },
  attempt: { state: 'idle' },
};

describe('submitWorkRun', () => {
  it('submits the complete intent and returns the queued run', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(run), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(submitWorkRun(spec, fetcher)).resolves.toEqual(run);
    expect(fetcher).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
  });
});

describe('RunSubmissionModal', () => {
  it('exposes every frozen-intent field before submission', () => {
    const html = renderToStaticMarkup(createElement(RunSubmissionModal, {
      onClose: () => undefined,
      onError: () => undefined,
      onSubmitted: () => undefined,
      repos: [{ id: '/repos/example', name: 'example', path: '/repos/example', currentBranch: 'main' }],
    }));

    expect(html).toContain('Submit durable run');
    expect(html).toContain('Objective');
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('Repository');
    expect(html).toContain('Requested base reference');
    expect(html).toContain('Runtime preference');
    expect(html).toContain('Budget');
    expect(html).toContain('Repository verification policy');
    expect(html).toContain('Requested delivery result');
    expect(html).toContain('Apply to repository (recommended)');
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
