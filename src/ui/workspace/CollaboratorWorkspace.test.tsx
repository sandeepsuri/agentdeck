// @vitest-environment jsdom
// The Collaborator workspace, exercised interactively: pick a Repository,
// read its Runs, open one and answer it, and request new work.
//
// Replaces MobileWorkspace.launch.test.tsx, which covered the "+ Launch a
// Run" panel this supersedes. Same mount/act pattern as that file and
// CollaboratorsPanel.test.tsx -- raw createRoot, no Testing Library.
//
// What a Collaborator is ALLOWED to see is not tested here: the server
// filters and narrows before any of this renders (app.test.ts,
// work-routes.test.ts, collaborator-run-view.test.ts). This file is about
// whether the workflow actually holds together.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Repo } from '../../types.js';
import type { CollaboratorRunDetail, CollaboratorRunSummary, Profile } from '../../work-engine/types.js';
import { CollaboratorWorkspace, type Props } from './CollaboratorWorkspace.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const principal = { id: 'collab-1', displayName: 'Alice' };
const granted: Repo = { id: 'repo-1', name: 'agentdeck', currentBranch: 'main', path: '' };
const other: Repo = { id: 'repo-2', name: 'web-client', currentBranch: 'main', path: '' };
const profile: Profile = {
  id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
  budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
};

function summary(overrides: Partial<CollaboratorRunSummary> = {}): CollaboratorRunSummary {
  return {
    id: 'run-1', status: 'running', objective: 'Fix the flaky auth test', acceptanceCriteria: ['It passes'],
    repository: { id: 'repo-1', name: 'agentdeck' }, submittedAt: '2026-09-01T00:00:00.000Z',
    requestedBy: 'Alice', preparation: { state: 'ready' }, attemptState: 'running', ...overrides,
  };
}

function detail(overrides: Partial<CollaboratorRunDetail> = {}): CollaboratorRunDetail {
  return {
    ...summary(), requestedBaseReference: 'main', profileId: 'profile-1',
    narrative: { steps: [], stepsTruncated: false }, ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mount(props: Partial<Props> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <CollaboratorWorkspace
        onError={() => undefined}
        onResolveRunAttention={() => undefined}
        onRunsStale={() => undefined}
        principal={principal}
        profiles={[profile]}
        repos={[granted]}
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
  vi.unstubAllGlobals();
});

describe('CollaboratorWorkspace navigation', () => {
  it('lands on the first granted Repository rather than an empty screen', async () => {
    const host = await mount({ runs: [summary()] });
    expect(host.textContent).toContain('agentdeck');
    expect(host.textContent).toContain('Fix the flaky auth test');
  });

  it('shows only the selected Repository\'s Runs, never another Repository\'s', async () => {
    const host = await mount({
      repos: [granted, other],
      runs: [summary(), summary({ id: 'run-2', objective: 'Bump the web deps', repository: { id: 'repo-2', name: 'web-client' } })],
    });
    expect(host.textContent).toContain('Fix the flaky auth test');
    expect(host.textContent).not.toContain('Bump the web deps');
  });

  it('lists every granted Repository in the drawer with its count of Runs in progress', async () => {
    const host = await mount({
      repos: [granted, other],
      runs: [summary(), summary({ id: 'run-2', status: 'completed' })],
    });
    const rows = [...host.querySelectorAll('[data-repo-id]')].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('1 active');
    expect(rows[1]).toContain('No Runs in progress');
  });

  it('orders Runs in progress ahead of finished ones', async () => {
    const host = await mount({
      runs: [
        summary({ id: 'done', status: 'completed', objective: 'Older finished work', submittedAt: '2026-09-02T00:00:00.000Z' }),
        summary({ id: 'live', status: 'running', objective: 'Live work', submittedAt: '2026-09-01T00:00:00.000Z' }),
      ],
    });
    const ids = [...host.querySelectorAll('[data-run-id]')].map((tile) => tile.getAttribute('data-run-id'));
    expect(ids).toEqual(['live', 'done']);
  });

  it('tells a Collaborator with no grants where to go instead of showing an empty list', async () => {
    const host = await mount({ repos: [] });
    expect(host.textContent).toContain('No Repositories have been granted to you');
  });
});

describe('CollaboratorWorkspace Run conversation', () => {
  it('opens a Run and renders what it did, its answer and its verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail({
      status: 'completed',
      narrative: {
        answer: 'The test was racing on a shared clock.',
        steps: [
          { label: 'Read src/auth/session.ts', status: 'completed', sequence: 1 },
          { label: 'Ran the test suite', status: 'completed', sequence: 2 },
        ],
        stepsTruncated: false,
        outcome: { kind: 'success' },
      },
    }))));

    const host = await mount({ runs: [summary()] });
    const tile = host.querySelector('[data-run-id="run-1"]') as HTMLButtonElement;
    await act(async () => { tile.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('The test was racing on a shared clock.');
    expect(host.textContent).toContain('Read src/auth/session.ts');
    expect(host.textContent).toContain('Completed successfully');
  });

  it('answers a pending approval through the one policy path, naming the Run and the attention request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail({
      status: 'waiting_approval',
      pendingAttention: { id: 'attn-1', kind: 'approval', reason: 'May I write to migrations/?', requestedAt: '2026-09-01T00:02:00.000Z' },
    }))));
    const onResolveRunAttention = vi.fn();

    const host = await mount({ onResolveRunAttention, runs: [summary({ status: 'waiting_approval', pendingAttentionKind: 'approval' })] });
    const tile = host.querySelector('[data-run-id="run-1"]') as HTMLButtonElement;
    await act(async () => { tile.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('May I write to migrations/?');
    const approve = [...host.querySelectorAll('.mobile-approval-actions button')]
      .find((button) => button.textContent === 'Approve') as HTMLButtonElement;
    await act(async () => { approve.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onResolveRunAttention).toHaveBeenCalledWith('run-1', 'attn-1', { kind: 'approve' });
  });

  it('relays a clarifying reply as input on the pending request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail({
      status: 'waiting_input',
      pendingAttention: { id: 'attn-2', kind: 'input', reason: 'Which branch should this target?', requestedAt: '2026-09-01T00:02:00.000Z' },
    }))));
    const onResolveRunAttention = vi.fn();

    const host = await mount({ onResolveRunAttention, runs: [summary({ status: 'waiting_input', pendingAttentionKind: 'input' })] });
    await act(async () => {
      (host.querySelector('[data-run-id="run-1"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const field = host.querySelector('input[aria-label="Clarifying input"]') as HTMLInputElement;
    await act(async () => { setInputValue(field, 'main'); });
    await act(async () => { field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(onResolveRunAttention).toHaveBeenCalledWith('run-1', 'attn-2', { kind: 'input', value: 'main' });
  });

  it('shows a finished Run\'s result — files, commit and gate verdicts by name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail({
      status: 'completed',
      narrative: { steps: [], stepsTruncated: false, outcome: { kind: 'success' } },
      result: {
        outcome: 'completed',
        changedFiles: ['src/auth/session.ts'],
        commit: { sha: 'deadbeefcafe1234', branch: 'agentdeck/run/1', signed: false },
        verification: [{ gate: 'tests', required: true, passed: true }],
        approvals: [],
      },
    }))));

    const host = await mount({ runs: [summary({ status: 'completed' })] });
    await act(async () => {
      (host.querySelector('[data-run-id="run-1"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('src/auth/session.ts');
    expect(host.textContent).toContain('deadbeefcafe');
    expect(host.textContent).toContain('tests');
  });
});

describe('CollaboratorWorkspace requesting work', () => {
  async function fillAndSubmit(host: HTMLElement) {
    await act(async () => {
      setInputValue(host.querySelector('textarea[aria-label="Objective"]') as HTMLTextAreaElement, 'Fix the flaky auth test');
      setInputValue(host.querySelector('textarea[aria-label="Acceptance criteria"]') as HTMLTextAreaElement, 'It passes ten times');
    });
    const form = host.querySelector('.mobile-request-composer form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    // The chain is three awaited round trips; let each settle inside act so
    // the composer's own submitting/notice state updates are covered too.
    await act(async () => { await Promise.resolve(); });
  }

  it('submits, prepares and starts, so a request becomes a running Run with no admin action', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === '/api/runs') return jsonResponse({ id: 'run-9' }, 201);
      return jsonResponse(detail({ id: 'run-9' }));
    }));
    const onRunsStale = vi.fn();

    const host = await mount({ onRunsStale });
    await fillAndSubmit(host);

    expect(calls.slice(0, 3)).toEqual(['/api/runs', '/api/runs/run-9/prepare', '/api/runs/run-9/start']);
    expect(onRunsStale).toHaveBeenCalled();
  });

  it('sends the Repository by id with no path, because a Collaborator is never told one', async () => {
    let submitted: unknown;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runs' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body));
        return jsonResponse({ id: 'run-9' }, 201);
      }
      return jsonResponse(detail({ id: 'run-9' }));
    }));

    const host = await mount();
    await fillAndSubmit(host);

    expect((submitted as { repository: unknown }).repository).toEqual({ id: 'repo-1', name: 'agentdeck', path: '' });
    expect((submitted as { profileId: string }).profileId).toBe('profile-1');
  });

  it('says why a request could not start, rather than reporting a Run that is not running', async () => {
    const note = 'This Repository has no verification policy configured yet, so work cannot start. Ask the admin to set one up.';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/runs') return jsonResponse({ id: 'run-9' }, 201);
      if (path === '/api/runs/run-9/prepare') return jsonResponse({ error: note }, 400);
      return jsonResponse(detail({ id: 'run-9', status: 'queued', preparation: { state: 'failed', note } }));
    }));

    const host = await mount();
    await fillAndSubmit(host);

    expect(host.textContent).toContain('no verification policy configured');
  });

  it('reports a refused submission and keeps the text the person wrote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Alice has not been granted this Profile.' }, 403)));
    const onError = vi.fn();

    const host = await mount({ onError });
    await fillAndSubmit(host);

    expect(onError).toHaveBeenCalledWith('Alice has not been granted this Profile.');
    expect((host.querySelector('textarea[aria-label="Objective"]') as HTMLTextAreaElement).value).toBe('Fix the flaky auth test');
  });

  it('explains that work cannot be requested when no Profile has been granted', async () => {
    const host = await mount({ profiles: [] });
    expect(host.textContent).toContain('No Profiles have been granted to you yet');
    expect(host.querySelector('textarea[aria-label="Objective"]')).toBeNull();
  });
});
