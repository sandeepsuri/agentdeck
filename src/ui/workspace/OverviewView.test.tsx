// @vitest-environment jsdom
// Admin-facing cross-Repository Overview and its per-Repository page
// (ticket 47, spec #37 B01). Exercised the same way as
// CollaboratorWorkspace.test.tsx: raw createRoot + act, asserting rendered
// output and click behavior rather than component internals.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { OverviewView, type Props } from './OverviewView.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const agentdeck: Repo = { id: 'repo-1', path: '/repos/agentdeck', name: 'agentdeck', currentBranch: 'main' };
const webClient: Repo = { id: 'repo-2', path: '/repos/web-client', name: 'web-client', currentBranch: 'main' };

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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1', origin: 'managed', agent: 'claude', cwd: '/repos/agentdeck',
    repoId: 'repo-1', startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
    status: 'working', statusSource: 'hook',
    ...overrides,
  };
}

async function mount(props: Partial<Props> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <OverviewView
        onSelectRun={() => undefined}
        onSelectSession={() => undefined}
        repos={[agentdeck]}
        runs={[]}
        sessions={[]}
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

describe('OverviewView landing', () => {
  it('lists every repository with its Run and Session counts', async () => {
    const host = await mount({
      repos: [agentdeck, webClient],
      runs: [run()],
      sessions: [session()],
    });
    const cards = [...host.querySelectorAll('[data-repo-id]')].map((card) => card.textContent);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('agentdeck');
    expect(cards[0]).toContain('1 run');
    expect(cards[0]).toContain('1 session');
    expect(cards[1]).toContain('web-client');
    expect(cards[1]).toContain('0 run');
  });

  it('flags a repository whose Run needs attention, generically, not as a personal queue', async () => {
    const host = await mount({
      runs: [run({ id: 'run-attn', pendingAttention: { id: 'att-1', kind: 'approval', reason: 'Touches production config', requestedAt: '2026-09-01T00:01:00.000Z' } })],
    });
    expect(host.textContent).toContain('1 needs attention');
    expect(host.textContent).not.toContain('your');
    expect(host.textContent).not.toContain('Your');
  });

  it('shows an honest empty state rather than a blank screen when no repositories are discovered', async () => {
    const host = await mount({ repos: [] });
    expect(host.textContent).toContain('No repositories found');
  });

  it('opens the Repository page on click and lists only that Repository\'s Runs and Sessions', async () => {
    const host = await mount({
      repos: [agentdeck, webClient],
      runs: [run(), run({ id: 'run-2', spec: { ...run().spec, objective: 'Bump web deps', repository: { id: 'repo-2', name: 'web-client', path: '/repos/web-client' } } })],
      sessions: [session()],
    });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('Fix the flaky auth test');
    expect(host.textContent).not.toContain('Bump web deps');
    expect(host.querySelector('[data-session-id="session-1"]')).not.toBeNull();
  });
});

describe('OverviewView Repository page', () => {
  it('filters Run and Session lists by their real status distinctions', async () => {
    const host = await mount({
      runs: [run(), run({ id: 'run-unverified', status: 'completed_unverified' })],
      sessions: [session(), session({ id: 'session-waiting', status: 'waiting_input' })],
    });
    await act(async () => { (host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement).click(); });
    const runFilter = host.querySelector('select[aria-label="Filter Runs by status"]') as HTMLSelectElement;
    const sessionFilter = host.querySelector('select[aria-label="Filter Sessions by status"]') as HTMLSelectElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(runFilter, 'completed_unverified');
      runFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('[data-run-id="run-unverified"]')).not.toBeNull();
    expect(host.querySelector('[data-run-id="run-1"]')).toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sessionFilter, 'waiting_input');
      sessionFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('[data-session-id="session-waiting"]')).not.toBeNull();
    expect(host.querySelector('[data-session-id="session-1"]')).toBeNull();
  });

  it('distinguishes Run rows from Session rows', async () => {
    const host = await mount({ runs: [run()], sessions: [session()] });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.querySelector('[data-run-id="run-1"]')?.textContent).toContain('RUN');
    expect(host.querySelector('[data-session-id="session-1"]')).not.toBeNull();
  });

  it('hands a Run row off to the existing Run detail via onSelectRun', async () => {
    const onSelectRun = vi.fn();
    const host = await mount({ runs: [run()], onSelectRun });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const row = host.querySelector('[data-run-id="run-1"]') as HTMLButtonElement;
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onSelectRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
  });

  it('hands a Session row off to the existing Session detail via onSelectSession', async () => {
    const onSelectSession = vi.fn();
    const host = await mount({ sessions: [session()], onSelectSession });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const row = host.querySelector('[data-session-id="session-1"]') as HTMLButtonElement;
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }));
  });

  it('shows an honest empty state for a repository with no work yet', async () => {
    const host = await mount({});
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('No Runs have been requested in agentdeck yet.');
    expect(host.textContent).toContain('No agents are running in agentdeck.');
  });

  it('returns to the Overview list on back, not to a blank screen', async () => {
    const host = await mount({ repos: [agentdeck, webClient] });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.textContent).toContain('Overview');

    const back = host.querySelector('.repository-page-back') as HTMLButtonElement;
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.querySelectorAll('[data-repo-id]')).toHaveLength(2);
  });

  it('falls back to the Overview list when the selected Repository is no longer discoverable', async () => {
    const host = await mount({ repos: [agentdeck] });
    const card = host.querySelector('[data-repo-id="repo-1"]') as HTMLButtonElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.querySelector('.repository-page')).not.toBeNull();

    // Repository revoked/unwatched mid-session — App.tsx's poll would stop
    // returning it in `repos`, the same shape a Collaborator's revoked
    // grant takes.
    await act(async () => { root!.render(<OverviewView onSelectRun={() => undefined} onSelectSession={() => undefined} repos={[]} runs={[]} sessions={[]} />); });

    expect(host.querySelector('.repository-page')).toBeNull();
    expect(host.textContent).toContain('No repositories found');
  });
});

describe('OverviewView restoring selection', () => {
  it('opens the Repository identity requested by global search', async () => {
    const host = await mount({ repos: [agentdeck, webClient], requestedRepositoryId: 'repo-2', requestedNavigationSequence: 1 });
    expect(host.querySelector('.repository-page')).not.toBeNull();
    expect(host.querySelector('.view-heading h1')?.textContent).toBe('web-client');
  });

  it('opens on the Repository behind an already-selected Run, e.g. from a deep link', async () => {
    const host = await mount({
      repos: [agentdeck, webClient],
      runs: [run()],
      selectedRunId: 'run-1',
    });
    expect(host.querySelector('.repository-page')).not.toBeNull();
    expect(host.textContent).toContain('agentdeck');
  });

  it('opens on the Repository behind an already-selected Session', async () => {
    const host = await mount({
      repos: [agentdeck, webClient],
      sessions: [session()],
      selectedId: 'session-1',
    });
    expect(host.querySelector('.repository-page')).not.toBeNull();
    expect(host.textContent).toContain('agentdeck');
  });

  it('highlights the currently selected Run and Session row', async () => {
    // selectedRunId already resolves to repo-1, so the Repository page is
    // open from the first render — no click needed to get there.
    const host = await mount({
      runs: [run(), run({ id: 'run-2' })],
      sessions: [session()],
      selectedRunId: 'run-2',
      selectedId: 'session-1',
    });

    expect(host.querySelector('[data-run-id="run-2"]')?.className).toContain('is-selected');
    expect(host.querySelector('[data-run-id="run-1"]')?.className).not.toContain('is-selected');
    expect(host.querySelector('[data-session-id="session-1"]')?.className).toContain('is-selected');
  });
});
