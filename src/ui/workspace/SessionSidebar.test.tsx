import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import type { RunStatus, WorkRun } from '../../work-engine/types.js';
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
  principal: { id: 'local:test', displayName: 'test' },
  preparation: { state: 'pending' },
  envelope: { state: 'pending' },
  verificationPolicy: { state: 'pending' },
  attempt: { state: 'idle' },
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
    expect(html).toContain('title="Implement durable managed work"');
    expect(html).toContain('RUN');
    expect(html).toContain('Queued');
    expect(html).toContain('Managed');
    expect(html).toContain('Discovered');
    expect(html).toContain('New run');
    expect(html).toContain('New session');
  });

  it('offers no delete affordance for a Run still in progress, even with onDeleteRun provided', () => {
    const html = renderToStaticMarkup(createElement(SessionSidebar, {
      discoveryStatus: null,
      onDeleteRun: () => undefined,
      onLaunch: () => undefined,
      onRefreshDiscovery: () => undefined,
      onSelect: () => undefined,
      onSelectRun: () => undefined,
      onSubmitRun: () => undefined,
      repos: [],
      runs: [run], // status: 'queued' — never terminal
      selectedId: null,
      selectedRunId: null,
      sessions: [],
    }));

    expect(html).not.toContain('Delete run');
  });

  it('offers a delete affordance once a Run reaches a terminal status, with onDeleteRun provided', () => {
    const html = renderToStaticMarkup(createElement(SessionSidebar, {
      discoveryStatus: null,
      onDeleteRun: () => undefined,
      onLaunch: () => undefined,
      onRefreshDiscovery: () => undefined,
      onSelect: () => undefined,
      onSelectRun: () => undefined,
      onSubmitRun: () => undefined,
      repos: [],
      runs: [{ ...run, status: 'completed' }],
      selectedId: null,
      selectedRunId: null,
      sessions: [],
    }));

    expect(html).toContain('Delete run');
  });

  it.each<RunStatus>([
    'queued', 'preparing', 'running', 'waiting_approval', 'waiting_input', 'waiting_dependency',
    'verifying', 'reviewing', 'completed', 'completed_unverified', 'failed_verification',
    'failed_budget', 'failed', 'pause_requested', 'paused', 'cancelled',
  ])('keeps the %s status available to the shared Runs color treatment', (status) => {
    const html = renderToStaticMarkup(createElement(SessionSidebar, {
      discoveryStatus: null,
      onLaunch: () => undefined,
      onRefreshDiscovery: () => undefined,
      onSelect: () => undefined,
      onSelectRun: () => undefined,
      repos: [],
      runs: [{ ...run, status }],
      selectedId: null,
      sessions: [],
    }));

    expect(html).toContain(`work-run-status status-${status}`);
  });
});
