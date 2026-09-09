import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { AdminSidebar } from './AdminSidebar.js';
import { WORKSPACE_VIEWS } from './model.js';

const session: Session = {
  id: 'session-attention', origin: 'managed', agent: 'codex', name: 'Waiting session',
  cwd: '/repos/example', startedAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T00:01:00.000Z', status: 'waiting_input', statusSource: 'hook',
};

const run: WorkRun = {
  id: 'run-attention', taskId: 'task-attention', status: 'waiting_input',
  submittedAt: '2026-09-01T00:00:00.000Z',
  spec: {
    objective: 'Answer the deployment question', acceptanceCriteria: ['Question answered'],
    repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
    requestedBaseReference: 'main', runtimePreference: ['codex'], budget: {},
    verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree',
  },
  principal: { id: 'local:test', displayName: 'test' }, preparation: { state: 'ready' },
  envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' }, attempt: { state: 'idle' },
  pendingAttention: { id: 'attention-1', kind: 'input', reason: 'Choose a target', requestedAt: '2026-09-01T00:01:00.000Z' },
};

describe('AdminSidebar', () => {
  it('keeps every workspace destination in one navigation', () => {
    const html = renderToStaticMarkup(createElement(AdminSidebar, {
      activeView: 'overview', onLaunch: () => undefined, onSelectRun: () => undefined,
      onSelectSession: () => undefined, onSubmitRun: () => undefined, onView: () => undefined,
      runs: [], sessions: [],
    }));

    for (const destination of WORKSPACE_VIEWS) expect(html).toContain(`>${destination.label}<`);
    expect(html).toContain('aria-label="Admin navigation"');
  });

  it('shows only attention-bearing work instead of the complete inventory', () => {
    const quietSession = { ...session, id: 'session-quiet', name: 'Quiet session', status: 'working' as const };
    const quietRun = { ...run, id: 'run-quiet', spec: { ...run.spec, objective: 'Quiet run' }, pendingAttention: undefined };
    const html = renderToStaticMarkup(createElement(AdminSidebar, {
      activeView: 'overview', onLaunch: () => undefined, onSelectRun: () => undefined,
      onSelectSession: () => undefined, onSubmitRun: () => undefined, onView: () => undefined,
      runs: [run, quietRun], sessions: [session, quietSession],
    }));

    expect(html).toContain('Answer the deployment question');
    expect(html).toContain('Waiting session');
    expect(html).not.toContain('Quiet run');
    expect(html).not.toContain('Quiet session');
  });
});
