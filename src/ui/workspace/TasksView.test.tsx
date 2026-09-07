// @vitest-environment jsdom
// Explicit, cross-Repository Run browsing (ticket 48, spec #37 B02).
// Exercised the same way as OverviewView.test.tsx: raw createRoot + act,
// asserting rendered output and click behavior rather than component
// internals.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkRun } from '../../work-engine/types.js';
import { TasksView, type Props } from './TasksView.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function run(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1', taskId: 'task-1', status: 'running',
    spec: {
      objective: 'Fix the flaky auth test', acceptanceCriteria: ['It passes'],
      repository: { id: 'repo-1', name: 'agentdeck', path: '/repos/agentdeck' },
      requestedBaseReference: 'main', runtimePreference: ['codex'],
      budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: 'local-commit',
    },
    submittedAt: '2026-09-01T00:00:00.000Z',
    principal: { id: 'local:admin', displayName: 'admin' },
    preparation: { state: 'ready' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

async function mount(props: Partial<Props> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <TasksView
        onSelectRun={() => undefined}
        onViewHistory={() => undefined}
        runs={[]}
        {...props}
      />,
    );
  });
  return container;
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('TasksView', () => {
  it('lists every Run across every Repository, without needing a Repository picked first', async () => {
    const host = await mount({
      runs: [
        run(),
        run({ id: 'run-2', spec: { ...run().spec, objective: 'Bump web deps', repository: { id: 'repo-2', name: 'web-client', path: '/repos/web-client' } } }),
      ],
    });
    expect(host.textContent).toContain('Fix the flaky auth test');
    expect(host.textContent).toContain('Bump web deps');
  });

  it('describes "Tasks" as objectives represented by existing Runs, not an independent record', async () => {
    const host = await mount();
    expect(host.textContent).toContain('Objectives represented by existing Runs');
  });

  it('bands attention-needing Runs first, then active work, then finished Runs', async () => {
    const host = await mount({
      runs: [
        run({ id: 'run-done', status: 'completed', submittedAt: '2026-09-01T02:00:00.000Z' }),
        run({ id: 'run-active', status: 'running', submittedAt: '2026-09-01T01:00:00.000Z' }),
        run({ id: 'run-attn', status: 'waiting_approval', submittedAt: '2026-09-01T00:00:00.000Z', pendingAttention: { id: 'att-1', kind: 'approval', reason: 'Touches prod', requestedAt: '2026-09-01T00:01:00.000Z' } }),
      ],
    });
    const order = [...host.querySelectorAll('.work-run-status')].map((el) => el.className);
    expect(order).toHaveLength(3);
    expect(order[0]).toContain('status-waiting_approval');
    expect(order[1]).toContain('status-running');
    expect(order[2]).toContain('status-completed');
  });

  it('shows an honest empty state rather than a blank screen when no Runs have been requested', async () => {
    const host = await mount({ runs: [] });
    expect(host.textContent).toContain('No Runs have been requested yet');
  });

  it('wraps a long objective instead of only ever truncating it', async () => {
    const long = 'Migrate the entire authentication subsystem off the legacy session store while preserving every existing collaborator grant and audit trail';
    const host = await mount({ runs: [run({ spec: { ...run().spec, objective: long } })] });
    const title = host.querySelector('.work-run-content strong');
    expect(title?.textContent).toBe(long);
    expect(title?.getAttribute('title')).toBe(long);
  });

  it('hands a Run off to the existing Run detail via onSelectRun', async () => {
    const onSelectRun = vi.fn();
    const host = await mount({ runs: [run()], onSelectRun });
    const row = host.querySelector('.work-run-select') as HTMLButtonElement;
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelectRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
  });

  it('highlights the currently selected Run', async () => {
    const host = await mount({ runs: [run(), run({ id: 'run-2' })], selectedRunId: 'run-2' });
    const rows = [...host.querySelectorAll('.work-run-row')];
    expect(rows[0]?.className).not.toContain('is-selected');
    expect(rows[1]?.className).toContain('is-selected');
  });

  it('renders without a crash or a stale highlight when the selected Run is no longer in the list (deleted, or filtered out mid-session)', async () => {
    const host = await mount({ runs: [run()], selectedRunId: 'run-vanished' });
    expect(host.querySelector('.work-run-row.is-selected')).toBeNull();
    expect(host.textContent).toContain('Fix the flaky auth test');
  });

  it('offers a distinct entry to ended Session History, separate from Run browsing', async () => {
    const onViewHistory = vi.fn();
    const host = await mount({ onViewHistory, historyCount: 3 });
    const link = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Session history')) as HTMLButtonElement;
    expect(link.textContent).toContain('3');
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onViewHistory).toHaveBeenCalled();
  });

  it('offers deletion only for a Run that has actually reached a terminal state, reusing the sidebar\'s own confirmation', async () => {
    const onDeleteRun = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const host = await mount({
      runs: [run({ id: 'run-active', status: 'running' }), run({ id: 'run-done', status: 'completed' })],
      onDeleteRun,
    });
    const deleteButtons = host.querySelectorAll('.row-delete-button');
    expect(deleteButtons).toHaveLength(1);
    await act(async () => { deleteButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onDeleteRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-done' }));
    confirmSpy.mockRestore();
  });
});
