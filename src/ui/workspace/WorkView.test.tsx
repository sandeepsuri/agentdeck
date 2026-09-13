// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, Repo, Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { deriveNeedsYou } from '../needsYou.js';
import type { WorkLayout } from '../preferences.js';
import { deriveWorkItems, type WorkFilters } from '../workItems.js';
import { WorkView } from './WorkView.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

const repos: Repo[] = [
  { id: 'repo-web', path: '/repos/web', name: 'web' },
  { id: 'repo-api', path: '/repos/api', name: 'api' },
];
const sessions: Session[] = [
  { id: 's-web', origin: 'external', agent: 'claude', name: 'Review dashboard', cwd: '/repos/web', repoId: 'repo-web', startedAt: '2026-09-10T11:00:00.000Z', lastActivityAt: '2026-09-10T11:40:00.000Z', status: 'waiting_input', statusSource: 'hook', pid: 4711, tty: 'ttys004', terminalApp: 'iTerm2' },
  { id: 's-api', origin: 'managed', agent: 'codex', name: 'Add rate limiting', cwd: '/repos/api', repoId: 'repo-api', startedAt: '2026-09-10T11:00:00.000Z', lastActivityAt: '2026-09-10T11:30:00.000Z', status: 'working', statusSource: 'hook' },
];
const runs: WorkRun[] = [{
  id: 'run-api', taskId: 't', status: 'completed', submittedAt: '2026-09-10T10:00:00.000Z',
  spec: { objective: 'Update API route', acceptanceCriteria: ['ok'], repository: { id: 'repo-api', name: 'api', path: '/repos/api' }, requestedBaseReference: 'main', runtimePreference: ['claude'], budget: {}, verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree' },
  principal: { id: 'local:admin', displayName: 'admin' }, preparation: { state: 'ready' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' }, attempt: { state: 'idle' },
}];
const events: AgentMessage[] = [{ ts: '2026-09-10T11:20:00.000Z', agent: 'codex:1', repo: '/repos/api', event: 'progress', sessionId: 's-api', message: 'Running vitest for middleware' }];
const needsYou = deriveNeedsYou({ runs, sessions, conflicts: [] });
const items = deriveWorkItems({ runs, sessions, historySessions: [], repos, needsYou });

function Harness({ onOpen, initialLayout = 'list' }: { onOpen: () => void; initialLayout?: WorkLayout }) {
  const [filters, setFilters] = useState<WorkFilters>({ status: 'all' });
  const [layout, setLayout] = useState<WorkLayout>(initialLayout);
  return <WorkView events={events} filters={filters} items={items} layout={layout} onFiltersChange={setFilters} onLayoutChange={setLayout} onOpen={onOpen} onStartWork={() => undefined} repos={repos} />;
}

async function mount(initialLayout: WorkLayout = 'list') {
  const onOpen = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness initialLayout={initialLayout} onOpen={onOpen} />));
  return onOpen;
}

const titles = () => [...host.querySelectorAll('.work-card-title')].map((element) => element.textContent);
const chip = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.work-status-chips button')].find((element) => element.textContent?.startsWith(label))!;

describe('WorkView', () => {
  it('lists runs and sessions together with status chips and counts', async () => {
    await mount();
    expect(titles()).toEqual(['Review dashboard', 'Add rate limiting', 'Update API route']);
    expect(chip('Needs you').textContent).toBe('Needs you1');
    await act(async () => { chip('Working').click(); });
    expect(titles()).toEqual(['Add rate limiting']);
  });

  it('filters by repository and agent', async () => {
    await mount();
    const [, repository, agent] = host.querySelectorAll<HTMLSelectElement>('.work-filters select, .work-filters input');
    await act(async () => { repository!.value = 'repo-api'; repository!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(titles()).toEqual(['Add rate limiting', 'Update API route']);
    await act(async () => { agent!.value = 'claude'; agent!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(titles()).toEqual(['Update API route']);
  });

  it('shows the same items and status in grid, with current activity and no sparklines or process identity by default', async () => {
    await mount('grid');
    expect(titles()).toEqual(['Review dashboard', 'Add rate limiting', 'Update API route']);
    expect(host.querySelector('.work-grid')).not.toBeNull();
    expect(host.textContent).toContain('Testing · Running vitest for middleware');
    expect(host.querySelector('.spark-bars')).toBeNull();
    const visibleText = [...host.querySelectorAll('.work-card-main')].map((element) => element.textContent).join(' ');
    expect(visibleText).not.toMatch(/4711|ttys004|PID|iTerm2|external/i);
    expect(host.querySelector('.work-advanced')?.textContent).toContain('4711');
  });

  it('opens an item', async () => {
    const onOpen = await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('.work-card-main')!.click(); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'session:s-web' }));
  });
});
