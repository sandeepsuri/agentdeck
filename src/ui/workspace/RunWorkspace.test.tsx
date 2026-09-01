import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkRun } from '../../work-engine/types.js';
import { RunWorkspace } from './RunWorkspace.js';

function baseRun(): WorkRun {
  return {
    id: 'run-durable-123',
    taskId: 'task-durable-123',
    status: 'queued',
    submittedAt: '2026-09-01T00:00:00.000Z',
    spec: {
      objective: 'Implement durable runs',
      acceptanceCriteria: ['Restart keeps identity'],
      repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
      requestedBaseReference: 'refs/heads/main',
      runtimePreference: ['codex', 'claude'],
      budget: { maxWallClockMs: 60000, maxModelTurns: 10 },
      verificationIntent: { required: true, commands: ['npm test'] },
      requestedDeliveryResult: 'local-commit',
    },
    preparation: { state: 'pending' },
    envelope: { state: 'pending' },
    attempt: { state: 'idle' },
  };
}

describe('RunWorkspace', () => {
  it('reopens and displays the queued run identity and full submitted intent', () => {
    const run = baseRun();

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of [
      'Run run-durable-123', 'Queued', 'Implement durable runs', 'Restart keeps identity',
      'example', 'refs/heads/main', 'codex → claude', 'npm test', 'Local commit',
    ]) expect(html).toContain(expected);
  });

  it('shows the Repository, resolved base commit, worktree, and preparation state once prepared', () => {
    const run: WorkRun = {
      ...baseRun(),
      status: 'preparing',
      preparation: {
        state: 'ready',
        baseCommit: 'abc123def456',
        worktreePath: '/repos/example-runs/run-durable-123',
        branch: 'agentdeck/run/run-durable-123',
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of ['example', 'Ready', 'abc123def456', '/repos/example-runs/run-durable-123']) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('Prepare worktree');
  });

  it('surfaces a failed preparation state and its recoverable explanation with a retry action', () => {
    const run: WorkRun = {
      ...baseRun(),
      preparation: { state: 'failed', error: 'Worktree path already exists: /repos/example-runs/run-durable-123' },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, onPrepare: () => undefined }));

    expect(html).toContain('Failed');
    expect(html).toContain('Worktree path already exists');
    expect(html).toContain('Retry worktree preparation');
  });

  it('offers no preparation action once a worktree is already ready', () => {
    const run: WorkRun = {
      ...baseRun(),
      preparation: { state: 'ready', baseCommit: 'abc123', worktreePath: '/repos/example-runs/run-durable-123' },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, onPrepare: () => undefined }));

    expect(html).not.toContain('Prepare worktree');
    expect(html).not.toContain('Retry worktree preparation');
  });

  it('shows the effective capability envelope once frozen', () => {
    const run: WorkRun = {
      ...baseRun(),
      envelope: {
        state: 'ready',
        capabilityEnvelope: {
          runtime: 'codex',
          profile: {
            writableWorktree: '/repos/example-runs/run-durable-123',
            readableRoots: ['/repos/example-runs/run-durable-123'],
            allowedNetworkDomains: ['api.openai.com', 'chatgpt.com'],
            environmentAllowlist: ['PATH', 'HOME'],
            processCeiling: 16,
            childRunCeiling: 0,
          },
          secretGrants: [{ name: 'github-token', reference: 'secret-ref:github-token-1' }],
        },
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of [
      'Capability envelope', 'Codex', '/repos/example-runs/run-durable-123',
      'api.openai.com', 'chatgpt.com', 'PATH', 'HOME', '16', 'github-token', 'secret-ref:github-token-1',
    ]) expect(html).toContain(expected);
  });

  it('shows a human-readable reason when the envelope is refused', () => {
    const run: WorkRun = {
      ...baseRun(),
      envelope: {
        state: 'refused',
        reason: 'No preferred runtime can satisfy the managed capability envelope. Claude Code: '
          + 'cannot enforce the managed capability envelope (execution restrictions unsupported).',
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    expect(html).toContain('Refused');
    expect(html).toContain('execution restrictions unsupported');
  });
});

function eligibleRun(): WorkRun {
  return {
    ...baseRun(),
    preparation: { state: 'ready', baseCommit: 'abc123', worktreePath: '/repos/example-runs/run-durable-123' },
    envelope: {
      state: 'ready',
      capabilityEnvelope: {
        runtime: 'codex',
        profile: {
          writableWorktree: '/repos/example-runs/run-durable-123',
          readableRoots: ['/repos/example-runs/run-durable-123'],
          allowedNetworkDomains: ['api.openai.com', 'chatgpt.com'],
          environmentAllowlist: ['PATH', 'HOME'],
          processCeiling: 16,
          childRunCeiling: 0,
        },
        secretGrants: [],
      },
    },
  };
}

describe('RunWorkspace Attempt panel (ticket 05, feature-gated)', () => {
  it('stays hidden when the feature gate is off, even for an eligible Run', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: eligibleRun(), structuredAttemptsEnabled: false }));

    expect(html).not.toContain('Start Attempt');
    expect(html).not.toContain('Attempt state');
  });

  it('stays hidden for a Run whose envelope runtime is not Codex, even with the gate on', () => {
    const base = eligibleRun();
    if (base.envelope.state !== 'ready') throw new Error('expected a ready envelope');
    const run: WorkRun = {
      ...base,
      envelope: { state: 'ready', capabilityEnvelope: { ...base.envelope.capabilityEnvelope, runtime: 'claude' } },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).not.toContain('Attempt state');
  });

  it('offers a Start Attempt action for an idle, eligible Run once the gate is on', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, {
      run: eligibleRun(), structuredAttemptsEnabled: true, onStart: () => undefined,
    }));

    expect(html).toContain('Start Attempt');
    expect(html).toContain('Idle');
  });

  it('offers no Start Attempt action without a handler, even when eligible', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: eligibleRun(), structuredAttemptsEnabled: true }));

    expect(html).not.toContain('Start Attempt');
  });

  it('shows ordered structured activity for a running Attempt, and no Start action once one is underway', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'running',
      attempt: {
        state: 'running',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'lifecycle', sequence: 1, at: '2026-09-01T00:05:01.000Z', phase: 'turn-started' },
          {
            kind: 'tool-activity', sequence: 2, at: '2026-09-01T00:05:02.000Z', tool: 'command_execution', status: 'started', summary: 'npm test',
          },
          {
            kind: 'message', sequence: 3, at: '2026-09-01T00:05:03.000Z', role: 'assistant', text: 'Working on the fix now.',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onStart: () => undefined }));

    expect(html).not.toContain('Start Attempt');
    expect(html).toContain('Attempt started');
    expect(html).toContain('Turn started');
    expect(html).toContain('npm test');
    expect(html).toContain('Working on the fix now.');
  });

  it('shows the terminal outcome for a completed Attempt', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'completion', sequence: 1, at: '2026-09-01T00:06:00.000Z', outcome: 'success',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Completed');
    expect(html).toContain('Success');
  });

  it('shows the precise failure reason as the terminal outcome for a failed Attempt', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'failed',
      attempt: {
        state: 'failed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        failedAt: '2026-09-01T00:06:00.000Z',
        reason: 'The sandboxed command exited non-zero.',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'failure', sequence: 1, at: '2026-09-01T00:06:00.000Z', reason: 'The sandboxed command exited non-zero.',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Failed');
    expect(html).toContain('The sandboxed command exited non-zero.');
  });
});
