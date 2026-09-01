import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkRun } from '../../work-engine/types.js';
import { RunWorkspace } from './RunWorkspace.js';

describe('RunWorkspace', () => {
  it('reopens and displays the queued run identity and full submitted intent', () => {
    const run: WorkRun = {
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
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of [
      'Run run-durable-123', 'Queued', 'Implement durable runs', 'Restart keeps identity',
      'example', 'refs/heads/main', 'codex → claude', 'npm test', 'Local commit',
    ]) expect(html).toContain(expected);
  });
});
