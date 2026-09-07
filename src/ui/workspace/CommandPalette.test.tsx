// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { CommandPalette, type Props } from './CommandPalette.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const repo: Repo = {
  id: 'repo-agentdeck', name: 'auth-service', path: '/repos/auth-service',
  currentBranch: 'main', isDirty: false, dirtyFiles: [],
};

function run(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-auth', taskId: 'task-auth', status: 'running',
    spec: {
      objective: 'Repair authentication retries', acceptanceCriteria: ['Retries pass'],
      repository: { id: repo.id, name: repo.name, path: repo.path },
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-auth', origin: 'managed', agent: 'codex', name: 'Auth watcher',
    repoId: repo.id, cwd: repo.path, branch: 'main', startedAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-01T00:01:00.000Z', status: 'working', statusSource: 'output_heuristic',
    ...overrides,
  };
}

async function mount(props: Partial<Props> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <CommandPalette
        onClose={() => undefined}
        onLaunch={() => undefined}
        onSelectRepo={() => undefined}
        onSelectRun={() => undefined}
        onSelectSession={() => undefined}
        onView={() => undefined}
        open
        repos={[repo]}
        runs={[run()]}
        sessions={[session()]}
        {...props}
      />,
    );
  });
  return container;
}

async function renderPalette(props: Partial<Props> = {}) {
  await act(async () => {
    root!.render(
      <CommandPalette
        onClose={() => undefined}
        onLaunch={() => undefined}
        onSelectRepo={() => undefined}
        onSelectRun={() => undefined}
        onSelectSession={() => undefined}
        onView={() => undefined}
        open
        repos={[repo]}
        runs={[run()]}
        sessions={[session()]}
        {...props}
      />,
    );
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('CommandPalette accessible work search', () => {
  it('matches authorized Repositories, Runs, and Sessions and navigates with their stable identity', async () => {
    const onSelectRepo = vi.fn();
    const onSelectRun = vi.fn();
    const onSelectSession = vi.fn();
    const host = await mount({ onSelectRepo, onSelectRun, onSelectSession });
    const input = host.querySelector('input') as HTMLInputElement;

    await act(async () => {
      typeInto(input, 'auth');
    });

    const repoResult = host.querySelector('[data-repo-id="repo-agentdeck"]') as HTMLButtonElement;
    const runResult = host.querySelector('[data-run-id="run-auth"]') as HTMLButtonElement;
    const sessionResult = host.querySelector('[data-session-id="session-auth"]') as HTMLButtonElement;
    expect(repoResult).not.toBeNull();
    expect(runResult).not.toBeNull();
    expect(sessionResult).not.toBeNull();

    await act(async () => { repoResult.click(); });
    await act(async () => { runResult.click(); });
    await act(async () => { sessionResult.click(); });
    expect(onSelectRepo).toHaveBeenCalledWith(expect.objectContaining({ id: 'repo-agentdeck' }));
    expect(onSelectRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-auth' }));
    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-auth' }));
  });

  it('keeps duplicate Run titles distinct and keyboard navigation opens the selected identity', async () => {
    const onSelectRun = vi.fn();
    const duplicateRuns = [
      run({ id: 'run-first', taskId: 'task-first', spec: { ...run().spec, objective: 'Duplicate objective' } }),
      run({ id: 'run-second', taskId: 'task-second', spec: { ...run().spec, objective: 'Duplicate objective' } }),
    ];
    const host = await mount({ onSelectRun, repos: [], runs: duplicateRuns, sessions: [] });
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => { typeInto(input, 'duplicate'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });

    expect(onSelectRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-second' }));
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const host = await mount({ onClose });
    const input = host.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); });
    expect(onClose).toHaveBeenCalled();
    await renderPalette({ onClose, open: false });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('shows a useful no-match state', async () => {
    const host = await mount();
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      typeInto(input, 'nothing-has-this-name');
    });
    expect(host.querySelector('.palette-empty')?.textContent).toContain('No sessions, repositories, runs, or actions match');
  });

  it('explains an empty authorized scope before any query is entered', async () => {
    const host = await mount({ onLaunch: undefined, onView: undefined, repos: [], runs: [], sessions: [] });
    expect(host.querySelector('.palette-empty')?.textContent).toContain('No accessible repositories, runs, or sessions');
  });

  it('drops results immediately when the authorized source data refreshes', async () => {
    const host = await mount({ repos: [], sessions: [] });
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      typeInto(input, 'authentication');
    });
    expect(host.querySelector('[data-run-id="run-auth"]')).not.toBeNull();

    await renderPalette({ repos: [], runs: [], sessions: [] });
    expect(host.querySelector('[data-run-id="run-auth"]')).toBeNull();
    expect(host.querySelector('.palette-empty')).not.toBeNull();
  });
});
