// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../types.js';
import type { RunReviewState } from '../../work-engine/run-review.js';
import type { WorkRun } from '../../work-engine/types.js';
import { ReviewView, type ReviewViewProps } from './ReviewView.js';

vi.mock('./ChangesWorkspace.js', () => ({ ChangesWorkspace: ({ repoPath }: { repoPath: string }) => <div data-testid="changes">Diff for {repoPath}</div> }));
vi.mock('./RunFeedbackPanel.js', () => ({ RunFeedbackPanel: () => <div>Feedback thread</div> }));

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });

const repos: Repo[] = [{ id: 'repo-api', path: '/repos/api', name: 'example-api', isDirty: true, dirtyFiles: ['a.ts'], currentBranch: 'main' }];

function completedRun(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1', taskId: 'task-1', status: 'completed', submittedAt: '2026-09-10T10:00:00.000Z',
    spec: {
      objective: 'Add rate limiting to /api/export', acceptanceCriteria: ['Returns 429', 'Configurable', 'Logged', 'Tested'],
      repository: { id: 'repo-api', name: 'example-api', path: '/repos/api' }, requestedBaseReference: 'main',
      runtimePreference: ['codex'], budget: {}, verificationIntent: { required: true, commands: ['npm test'] }, requestedDeliveryResult: 'pull-request',
    },
    principal: { id: 'local:admin', displayName: 'admin' },
    preparation: { state: 'ready', worktreePath: '/worktrees/rate-limit' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
    attempt: {
      state: 'completed', runtime: 'codex', startedAt: '2026-09-10T10:00:00.000Z', completedAt: '2026-09-10T10:30:00.000Z',
      events: [
        { kind: 'completion', sequence: 1, at: '2026-09-10T10:20:00.000Z', outcome: 'success' },
        { kind: 'verification-check', sequence: 2, at: '2026-09-10T10:21:00.000Z', gate: 'Typecheck', command: 'npm run typecheck', required: true, passed: true, exitCode: 0, evidence: 'ok' },
        { kind: 'verification-check', sequence: 3, at: '2026-09-10T10:22:00.000Z', gate: 'Tests', command: 'npm test', required: true, passed: true, exitCode: 0, evidence: '42 passed' },
        { kind: 'commit-created', sequence: 4, at: '2026-09-10T10:23:00.000Z', sha: 'abc123def4567', branch: 'agentdeck/run/rate-limit', signed: false, changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
        { kind: 'verification-outcome', sequence: 5, at: '2026-09-10T10:24:00.000Z', outcome: 'verified', repairAttempts: 0 },
      ],
    },
    ...overrides,
  };
}

async function mount(props: Partial<ReviewViewProps> = {}) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/repos/diff')) return new Response(JSON.stringify({ files: [{ additions: 100, deletions: 20 }, { additions: 50, deletions: 10 }, { additions: 20, deletions: 10 }, { additions: 13, deletions: 6 }] }), { status: 200 });
    if (url.endsWith('/feedback') && init?.method === 'POST') return new Response(JSON.stringify({ id: 'f', text: 'Approved.' }), { status: 201 });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const handlers = {
    onSelectTarget: vi.fn(), onReviewDecided: vi.fn(), onOpenInWork: vi.fn(), onApply: vi.fn(), onReverify: vi.fn(), onPreview: vi.fn(),
    onPublish: vi.fn(async () => undefined), onError: vi.fn(),
  };
  const run = completedRun();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ReviewView activeRepositoryId={null} claims={[]} repos={repos} reviewStates={new Map<string, RunReviewState>([['run-1', { state: 'ready_to_review' }]])} runs={[run]} sessions={[]} target={{ kind: 'run', runId: 'run-1' }} {...handlers} {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { fetcher, handlers };
}

const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.textContent?.trim().startsWith(label))!;

describe('ReviewView', () => {
  it('lists review-ready work and uncommitted repository changes in one place', async () => {
    const { handlers } = await mount({ target: null });
    const list = host.querySelector('.review-list')!.textContent ?? '';
    expect(list).toContain('Ready for review');
    expect(list).toContain('Add rate limiting to /api/export');
    expect(list).toContain('Uncommitted changes');
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('.review-row')[1]!.click(); });
    expect(handlers.onSelectTarget).toHaveBeenCalledWith({ kind: 'repository', repositoryId: 'repo-api' });
  });

  it('summarises criteria, verification, size and risk above Summary, Changes, Tests and Activity tabs', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text).toContain('4 acceptance criteria');
    expect(text).toContain('✓ Typecheck');
    expect(text).toContain('✓ Tests');
    expect(text).toContain('+183');
    expect(text).toContain('−46');
    expect(host.querySelector('.review-facts .risk-badge')?.textContent).toBe('Medium');
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Summary', 'Changes', 'Tests', 'Activity']);

    await act(async () => { host.querySelector<HTMLButtonElement>('#review-tab-changes')!.click(); });
    expect(host.querySelector('[data-testid="changes"]')?.textContent).toBe('Diff for /worktrees/rate-limit');
    await act(async () => { host.querySelector<HTMLButtonElement>('#review-tab-tests')!.click(); });
    expect(host.querySelector('#review-tabpanel-tests')?.textContent).toContain('npm test');
  });

  it('records an approval as a review decision', async () => {
    const { fetcher, handlers } = await mount();
    await act(async () => { button('Approve').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const post = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/feedback') && init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toEqual({ text: 'Approved.', reviewDecision: 'reviewed' });
    expect(handlers.onReviewDecided).toHaveBeenCalledWith('run-1');
  });

  it('keeps shipping explicit: every external effect needs a confirmation step', async () => {
    const { handlers } = await mount();
    await act(async () => { button('Ship').click(); });
    const labels = [...host.querySelectorAll('[role="menuitem"] strong')].map((element) => element.textContent);
    expect(labels).toEqual(['Leave in working tree', 'Apply local commit to repository', 'Push branch', 'Open draft pull request']);

    await act(async () => { button('Open draft pull request').click(); });
    expect(handlers.onPublish).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('Push agentdeck/run/rate-limit and open a draft pull request?');
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alertdialog"] .button-primary')!.click(); });
    expect(handlers.onPublish).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), 'draft-pull-request');
  });

  it('refuses to publish work without a verified local commit', async () => {
    const run = completedRun({ status: 'completed_unverified' });
    await mount({ runs: [run] });
    await act(async () => { button('Ship').click(); });
    const push = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((element) => element.textContent?.startsWith('Push branch'))!;
    expect(push.disabled).toBe(true);
    expect(push.textContent).toContain('Needs a verified local commit first.');
  });
});
