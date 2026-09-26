// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { deriveNeedsYou } from '../needsYou.js';
import { deriveWorkItems } from '../workItems.js';
import { DeveloperOverview, type DeveloperOverviewProps } from './DeveloperOverview.js';

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

async function mount(props: Partial<DeveloperOverviewProps> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ periods: [{ period: 'month', current: { costUsd: 212 } }], allTime: {}, indexing: false }), { status: 200 })));
  const runs = [approvalRun];
  const sessions = [workingSession];
  const needsYou = deriveNeedsYou({ runs, sessions, conflicts: [] });
  const workItems = deriveWorkItems({ runs, sessions, historySessions: [], repos, needsYou });
  const handlers = {
    onStartWork: vi.fn(), onOpenWorkItem: vi.fn(), onSelectRepository: vi.fn(), onOpenUsage: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<DeveloperOverview rateLimits={[{ provider: 'codex', observedAt: 'x', secondary: { usedPercent: 74, windowMinutes: 10_080 } }]} repos={repos} repositoryActivity={new Map([['repo-web', { active: 2, waiting: 1 }]])} workItems={workItems} {...handlers} {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return handlers;
}

const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)!;

describe('DeveloperOverview', () => {
  it('keeps the developer dashboard order — active work, usage, repositories — and leaves Needs You to Home', async () => {
    await mount();
    const text = host.textContent ?? '';
    const order = ['Active work', 'Usage this month', 'Repositories'].map((label) => text.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Overview');
    expect(text).not.toContain('Needs you');
  });

  it('shows active work at a glance without process identity, and compact usage only', async () => {
    const handlers = await mount();
    expect(host.textContent).toContain('Build activity feed');
    expect(host.textContent).not.toMatch(/4711|ttys004|PID/);
    expect(host.textContent).toContain('$212');
    expect(host.textContent).toContain('Codex weekly limit74%');
    expect(host.textContent).not.toContain('Model news');
    await act(async () => { host.querySelector<HTMLButtonElement>('.home-repo-card')!.click(); });
    expect(handlers.onSelectRepository).toHaveBeenCalledWith('repo-web');
  });
});
