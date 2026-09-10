// The request chain, with an injected fetcher — no DOM, no server. What each
// of the three calls is allowed to do is enforced server-side
// (work-engine/policy.ts); this file only pins down that all three are made,
// in order, and that stopping short of a running Attempt is reported
// honestly rather than swallowed.
import { describe, expect, it } from 'vitest';
import { requestWork } from './collaboratorRuns.js';
import type { WorkSpec } from '../work-engine/types.js';

const spec: WorkSpec = {
  objective: 'Add the missing test',
  acceptanceCriteria: ['The test exists'],
  repository: { id: 'repo-1', name: 'example', path: '' },
  requestedBaseReference: 'main',
  runtimePreference: ['codex'],
  budget: {},
  verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit',
  profileId: 'profile-1',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Records every path called, answering each with the caller-supplied reply. */
function recorder(replies: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  const fetcher = (path: string) => {
    calls.push(path);
    const reply = replies[path];
    if (!reply) throw new Error(`unexpected request: ${path}`);
    return Promise.resolve(typeof reply === 'function' ? reply() : reply);
  };
  return { calls, fetcher };
}

describe('requestWork', () => {
  it('submits, prepares and starts in order, reporting a running Run', async () => {
    const { calls, fetcher } = recorder({
      '/api/runs': () => json(201, { id: 'run-1' }),
      '/api/runs/run-1/prepare': () => json(200, { id: 'run-1' }),
      '/api/runs/run-1/start': () => json(200, { id: 'run-1' }),
    });

    await expect(requestWork(spec, fetcher)).resolves.toEqual({ runId: 'run-1', stage: 'running' });
    expect(calls).toEqual(['/api/runs', '/api/runs/run-1/prepare', '/api/runs/run-1/start']);
  });

  it('stops at prepare, never calling start, and carries the reason the Collaborator needs', async () => {
    const note = 'This Repository has no verification policy configured yet, so work cannot start. Ask the admin to set one up.';
    const { calls, fetcher } = recorder({
      '/api/runs': () => json(201, { id: 'run-1' }),
      '/api/runs/run-1/prepare': () => json(400, { error: note }),
    });

    await expect(requestWork(spec, fetcher)).resolves.toEqual({ runId: 'run-1', stage: 'queued', note });
    expect(calls).toEqual(['/api/runs', '/api/runs/run-1/prepare']);
  });

  it('reports a Run that prepared but could not start — the Run still exists, so it is queued rather than lost', async () => {
    const { fetcher } = recorder({
      '/api/runs': () => json(201, { id: 'run-1' }),
      '/api/runs/run-1/prepare': () => json(200, { id: 'run-1' }),
      '/api/runs/run-1/start': () => json(400, { error: 'no runtime is available' }),
    });

    await expect(requestWork(spec, fetcher)).resolves.toEqual({
      runId: 'run-1', stage: 'queued', note: 'no runtime is available',
    });
  });

  it('throws when the submission itself is refused, because no Run was created to navigate to', async () => {
    const { calls, fetcher } = recorder({
      '/api/runs': () => json(403, { error: 'Alice has not been granted this Profile.', rule: 'profile-not-granted' }),
    });

    await expect(requestWork(spec, fetcher)).rejects.toThrow('Alice has not been granted this Profile.');
    expect(calls).toEqual(['/api/runs']);
  });

  it('still reports a stage when a failing step returns no parseable body', async () => {
    const { fetcher } = recorder({
      '/api/runs': () => json(201, { id: 'run-1' }),
      '/api/runs/run-1/prepare': () => new Response('', { status: 500 }),
    });

    await expect(requestWork(spec, fetcher)).resolves.toEqual({
      runId: 'run-1', stage: 'queued', note: 'The Run was created but could not prepare.',
    });
  });
});
