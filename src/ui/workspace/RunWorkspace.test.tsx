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
});
