// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { deriveNeedsYou } from '../needsYou.js';
import { deriveWorkItems } from '../workItems.js';
import { combineSourceStates, homeTasks, HomeView, type HomeViewProps } from './HomeView.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });

const repos: Repo[] = [{ id: 'repo-web', path: '/repos/example-web', name: 'example-web', currentBranch: 'main' }];
const approvalRun: WorkRun = {
  id: 'run-approval', taskId: 'task', status: 'waiting_approval',
  spec: {
    objective: 'Review dashboard', acceptanceCriteria: ['ok'],
    repository: { id: 'repo-web', name: 'example-web', path: '/repos/example-web' },
    requestedBaseReference: 'main', runtimePreference: ['claude'], budget: {},
    verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree',
  },
  submittedAt: '2026-09-10T11:00:00.000Z', principal: { id: 'local:admin', displayName: 'admin' },
  preparation: { state: 'ready', worktreePath: '/worktrees/dashboard' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
  attempt: { state: 'idle' },
  pendingAttention: { id: 'att-1', kind: 'approval', reason: 'Claude is requesting approval to use Bash: npx playwright test', requestedAt: '2026-09-10T11:30:00.000Z' },
};
const workingSession: Session = {
  id: 'session-1', origin: 'managed', agent: 'codex', name: 'Build activity feed', cwd: '/repos/example-web', repoId: 'repo-web',
  startedAt: '2026-09-10T11:00:00.000Z', lastActivityAt: '2026-09-10T11:30:00.000Z', status: 'working', statusSource: 'hook', pid: 4711, tty: 'ttys004',
};
const finishedSession: Session = {
  ...workingSession, id: 'session-2', name: 'Tidy changelog', status: 'completed', lastActivityAt: '2026-09-10T11:40:00.000Z',
};

function data(runs: WorkRun[], sessions: Session[]) {
  const needsYou = deriveNeedsYou({ runs, sessions, conflicts: [] });
  const workItems = deriveWorkItems({ runs, sessions, historySessions: [], repos, needsYou });
  return { runs, needsYou, workItems };
}

async function mount(props: Partial<HomeViewProps> = {}) {
  const handlers = {
    onAsk: vi.fn(), onOpenNeedsYou: vi.fn(), onOpenWorkItem: vi.fn(), onOpenWork: vi.fn(), onOpenSettings: vi.fn(),
    onResolveRunAttention: vi.fn(async () => undefined),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<HomeView {...data([approvalRun], [workingSession, finishedSession])} repositoryCount={1} sources={{ work: 'ready', repositories: 'ready' }} {...handlers} {...props} />);
  });
  return handlers;
}

const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)!;
const section = (heading: string) => [...host.querySelectorAll('section[aria-labelledby]')].find((element) => element.querySelector('h2')?.textContent === heading)!;
const ask = () => host.querySelector<HTMLTextAreaElement>('textarea')!;

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ask(), value);
  ask().dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HomeView (everyday)', () => {
  it('shows Ask, Needs you and Tasks in that order, and none of the developer dashboard', async () => {
    await mount();
    const headings = [...host.querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(headings).toEqual(['Ask', 'Needs you', 'Tasks']);
    expect(host.textContent).not.toMatch(/Repositories|Usage this month|4711|ttys004/);
  });

  it('labels every region and the Ask field for assistive technology', async () => {
    await mount();
    for (const name of ['Ask', 'Needs you', 'Tasks']) {
      const region = section(name);
      expect(host.querySelector(`#${region.getAttribute('aria-labelledby')}`)?.textContent).toBe(name);
    }
    expect(ask().labels?.[0]?.textContent).toContain('What do you want done?');
    expect(ask().getAttribute('aria-describedby')).toBeTruthy();
  });

  it('hands an Ask to Start work with the typed text, and does nothing when it is blank', async () => {
    const handlers = await mount();
    expect(button('Continue').disabled).toBe(true);
    await act(async () => { type('  Add a dark mode toggle  '); });
    await act(async () => { button('Continue').click(); });
    expect(handlers.onAsk).toHaveBeenCalledWith('Add a dark mode toggle');
    expect(ask().value).toBe('');
  });

  it('submits an Ask with Enter but keeps Shift+Enter for a new line', async () => {
    const handlers = await mount();
    await act(async () => { type('Fix login'); });
    await act(async () => { ask().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    expect(handlers.onAsk).not.toHaveBeenCalled();
    await act(async () => { ask().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(handlers.onAsk).toHaveBeenCalledWith('Fix login');
  });

  it('says honestly that Ask cannot start work until a repository exists', async () => {
    const handlers = await mount({ repositoryCount: 0 });
    expect(ask().disabled).toBe(true);
    expect(section('Ask').textContent).toContain('Add a repository');
    await act(async () => { button('Open Settings').click(); });
    expect(handlers.onOpenSettings).toHaveBeenCalled();
  });

  it('lets a real Run approval be answered inline from Needs you', async () => {
    const handlers = await mount();
    await act(async () => { button('Respond').click(); });
    expect(host.textContent).toContain('Working directory: /worktrees/dashboard');
    await act(async () => { button('Approve once').click(); });
    expect(handlers.onResolveRunAttention).toHaveBeenCalledWith('run-approval', 'att-1', { kind: 'approve' });
    expect(handlers.onOpenNeedsYou).not.toHaveBeenCalled();
  });

  it('lists real work as Tasks, active before finished, and opens it', async () => {
    const handlers = await mount();
    const text = section('Tasks').textContent ?? '';
    expect(text.indexOf('Build activity feed')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Build activity feed')).toBeLessThan(text.indexOf('Tidy changelog'));
    await act(async () => { [...section('Tasks').querySelectorAll('button')].find((element) => element.textContent?.includes('Build activity feed'))!.click(); });
    expect(handlers.onOpenWorkItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'session:session-1' }));
    await act(async () => { button('See all work').click(); });
    expect(handlers.onOpenWork).toHaveBeenCalled();
  });

  it('shows plain empty states once everything has loaded', async () => {
    await mount({ ...data([], []) });
    expect(section('Needs you').textContent).toContain('Nothing needs you right now.');
    expect(section('Tasks').textContent).toContain('No tasks yet');
  });

  it('says it is still checking while work is loading rather than claiming nothing is there', async () => {
    await mount({ ...data([], []), sources: { work: 'loading', repositories: 'loading' } });
    expect(section('Needs you').querySelector('[role="status"]')?.textContent).toContain('Checking');
    expect(section('Tasks').querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(host.textContent).not.toContain('Nothing needs you right now.');
    expect(host.textContent).not.toContain('No tasks yet');
  });

  it('reports an unreachable server instead of an empty queue, and keeps last-known items marked incomplete', async () => {
    await mount({ ...data([], []), sources: { work: 'error', repositories: 'ready' } });
    expect(section('Needs you').querySelector('[role="alert"]')?.textContent).toContain('Couldn’t check');
    expect(section('Tasks').querySelector('[role="alert"]')?.textContent).toContain('Couldn’t load');
    expect(host.textContent).not.toContain('Nothing needs you right now.');

    await act(async () => root.unmount());
    host.remove();
    await mount({ sources: { work: 'error', repositories: 'ready' } });
    expect(section('Needs you').textContent).toContain('Review dashboard');
    expect(section('Needs you').querySelector('[role="alert"]')?.textContent).toContain('may be out of date');
  });
});

describe('Home source states', () => {
  it('is only ready once every source has answered, and any failure wins', () => {
    expect(combineSourceStates('ready', 'ready')).toBe('ready');
    expect(combineSourceStates('ready', 'loading')).toBe('loading');
    expect(combineSourceStates('loading', 'error')).toBe('error');
  });

  it('keeps archived work out of Tasks and caps the list', () => {
    const { workItems } = data([], Array.from({ length: 12 }, (_, index) => ({ ...workingSession, id: `s-${index}` })));
    expect(homeTasks(workItems)).toHaveLength(10);
    const archived = { ...workItems[0]!, bucket: 'archived' as const };
    expect(homeTasks([archived])).toEqual([]);
  });
});
