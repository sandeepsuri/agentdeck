import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { SessionSidebar } from './SessionSidebar.js';

const session: Session = {
  id: 'session-1',
  origin: 'managed',
  agent: 'codex',
  cwd: '/repos/example',
  startedAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T00:00:00.000Z',
  status: 'working',
  statusSource: 'output_heuristic',
};

const run: WorkRun = {
  id: 'run-1',
  taskId: 'task-1',
  status: 'queued',
  submittedAt: '2026-09-01T00:00:00.000Z',
  spec: {
    objective: 'Implement durable managed work',
    acceptanceCriteria: ['It survives restart'],
    repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
    requestedBaseReference: 'main',
    runtimePreference: ['codex'],
    budget: { maxModelTurns: 20 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'local-commit',
  },
};

describe('SessionSidebar', () => {
  it('renders Runs as a distinct resource beside managed and external Sessions', () => {
    const html = renderToStaticMarkup(createElement(SessionSidebar, {
      discoveryStatus: null,
      onLaunch: () => undefined,
      onRefreshDiscovery: () => undefined,
      onSelect: () => undefined,
      onSelectRun: () => undefined,
      onSubmitRun: () => undefined,
      repos: [],
      runs: [run],
      selectedId: session.id,
      selectedRunId: null,
      sessions: [session],
    }));

    expect(html).toContain('Runs');
    expect(html).toContain('Implement durable managed work');
    expect(html).toContain('RUN');
    expect(html).toContain('Queued');
    expect(html).toContain('Managed');
    expect(html).toContain('Discovered');
    expect(html).toContain('New run');
    expect(html).toContain('New session');
  });
});
