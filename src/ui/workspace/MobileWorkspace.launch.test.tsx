// @vitest-environment jsdom
// Ticket 12 AC1/AC6: the collaborator "Launch a Run" flow inside
// MobileWorkspace, exercised interactively (click to open, fill the form,
// submit) — same mount/act pattern ControlKeys.test.tsx and
// CollaboratorsPanel.test.tsx use. MobileWorkspace.test.ts's static-render
// suite covers everything else about this component; this file is only
// about the new launch panel.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Repo } from '../../types.js';
import type { Profile } from '../../work-engine/types.js';
import { MobileWorkspace } from './MobileWorkspace.js';

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

async function mount(props: Partial<Parameters<typeof MobileWorkspace>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MobileWorkspace
        onError={() => undefined}
        onSelect={() => undefined}
        session={null}
        sessions={[]}
        ws={null}
        wsReady={false}
        {...props}
      />,
    );
  });
  return container;
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

const principal = { id: 'collab-1', displayName: 'Alice' };
const repo: Repo = { id: 'repo-1', name: 'agentdeck', path: '/repos/agentdeck', currentBranch: 'main' };
const profile: Profile = {
  id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
  budget: { maxWallClockMs: 900_000 }, verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
};

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MobileWorkspace collaborator launch panel', () => {
  it('opens the panel and submits a Run via POST /api/runs (ticket 12 AC1)', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => jsonResponse({ id: 'run-1', status: 'queued' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount({ collaboratorPrincipal: principal, collaboratorRepos: [repo], collaboratorProfiles: [profile] });
    const openButton = host.querySelector('button[aria-label="Launch a Run"]') as HTMLButtonElement;
    await act(async () => { openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('Launch a Run as Alice');

    const objective = host.querySelector('textarea') as HTMLTextAreaElement;
    const [, acceptanceCriteria] = Array.from(host.querySelectorAll('textarea'));
    await act(async () => {
      setInputValue(objective, 'Fix the flaky login test');
      setInputValue(acceptanceCriteria as HTMLTextAreaElement, 'The test passes reliably');
    });

    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/runs');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.objective).toBe('Fix the flaky login test');
    expect(body.acceptanceCriteria).toEqual(['The test passes reliably']);
    expect(body.repository).toEqual({ id: 'repo-1', name: 'agentdeck', path: '/repos/agentdeck' });
    expect(body.profileId).toBe('profile-1');
    // The Profile's own fields, not left blank — the server overwrites them
    // regardless, but the form's own summary should match what will run.
    expect(body.runtimePreference).toEqual(['codex']);
    expect(host.textContent).toContain('Run queued.');
  });

  it('surfaces the server\'s denial reason (e.g. an ungranted Repository) rather than silently failing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Alice has not been granted this Repository.', rule: 'repository-not-granted' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const host = await mount({ collaboratorPrincipal: principal, collaboratorRepos: [repo], collaboratorProfiles: [profile], onError });
    const openButton = host.querySelector('button[aria-label="Launch a Run"]') as HTMLButtonElement;
    await act(async () => { openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const [objectiveField, acceptanceField] = Array.from(host.querySelectorAll('textarea'));
    await act(async () => {
      setInputValue(objectiveField as HTMLTextAreaElement, 'Fix the flaky login test');
      setInputValue(acceptanceField as HTMLTextAreaElement, 'The test passes reliably');
    });

    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(onError).toHaveBeenCalledWith('Alice has not been granted this Repository.');
  });

  it('explains why launching is unavailable when no Repository or Profile has been granted yet', async () => {
    const host = await mount({ collaboratorPrincipal: principal, collaboratorRepos: [], collaboratorProfiles: [] });
    const openButton = host.querySelector('button[aria-label="Launch a Run"]') as HTMLButtonElement;
    await act(async () => { openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.textContent).toContain('No Repositories have been granted to you yet.');
  });

  it('never renders the launch button at all for the ordinary admin phone connection', async () => {
    const host = await mount();
    expect(host.querySelector('button[aria-label="Launch a Run"]')).toBeNull();
  });
});
