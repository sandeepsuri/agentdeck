// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { Repo } from '../../types.js';
import { StartWorkModal } from './StartWorkModal.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

const repos: Repo[] = [
  { id: '/repos/agentdeck', path: '/repos/agentdeck', name: 'agentdeck', currentBranch: 'main' },
  { id: '/repos/web', path: '/repos/web', name: 'web', currentBranch: 'develop' },
];

function readiness(claude: 'managed' | 'compatibility-only' | 'unavailable', codex: 'managed' | 'unavailable' = 'managed'): RuntimeReadinessReport {
  return {
    checkedAt: '2026-09-10T00:00:00.000Z',
    runtimes: [
      { runtime: 'codex', displayName: 'Codex CLI', status: codex, reason: codex === 'managed' ? 'ok' : 'Codex CLI is not installed or is not executable.', capabilities: [] },
      { runtime: 'claude', displayName: 'Claude Code', status: claude, reason: claude === 'managed' ? 'ok' : 'Managed approval and usage protocols require Claude Code 2.1.208 or newer.', capabilities: [] },
    ],
  };
}

let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

type FetchCall = { url: string; init?: RequestInit };

async function mount(report: RuntimeReadinessReport, props: Partial<Parameters<typeof StartWorkModal>[0]> = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/runtime-readiness')) return new Response(JSON.stringify(report), { status: 200 });
    if (url.startsWith('/api/repos/verification-policy') && init?.method !== 'PUT') return new Response(JSON.stringify({ policy: null }), { status: 200 });
    if (url.startsWith('/api/repos/verification-policy')) return new Response(JSON.stringify({ policy: {} }), { status: 200 });
    if (url === '/api/sessions') return new Response(JSON.stringify({ id: 'session-new' }), { status: 201 });
    if (url === '/api/runs') return new Response(JSON.stringify({ id: 'run-new' }), { status: 201 });
    throw new Error(`Unexpected request ${url}`);
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const handlers = { onClose: vi.fn(), onError: vi.fn(), onLaunched: vi.fn(), onSubmitted: vi.fn() };
  await act(async () => {
    root.render(<StartWorkModal repos={repos} {...handlers} {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { calls, ...handlers };
}

async function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function field(label: string): HTMLElement {
  const found = [...host.querySelectorAll('label')].find((element) => element.textContent?.startsWith(label));
  if (!found) throw new Error(`no field labelled ${label}`);
  return found.querySelector('textarea, input, select')!;
}

async function submit() {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('StartWorkModal', () => {
  it('asks only for the task, repository, agent and mode up front', async () => {
    await mount(readiness('managed'));
    expect(host.textContent).toContain('What do you want done?');
    expect(host.textContent).toContain('Repository');
    expect(host.textContent).toContain('Agent');
    expect(host.textContent).toContain('Quick');
    expect(host.textContent).toContain('Structured');
    expect(host.textContent).not.toContain('Acceptance criteria');
  });

  it('starts from the text typed into Home’s Ask, still editable and still unsent', async () => {
    const { calls } = await mount(readiness('managed'), { initialTask: 'Add a dark mode toggle' });
    expect((field('What do you want done?') as HTMLTextAreaElement).value).toBe('Add a dark mode toggle');
    expect(calls.some((call) => call.url === '/api/sessions' || call.url === '/api/runs')).toBe(false);
  });

  it('Quick mode launches an ad hoc session without criteria or budgets', async () => {
    const { calls, onLaunched } = await mount(readiness('managed'), { initialRepositoryId: '/repos/web' });
    await type(field('What do you want done?') as HTMLTextAreaElement, 'Fix the flaky auth test\nIt fails on CI');
    await submit();

    const launch = calls.find((call) => call.url === '/api/sessions');
    expect(JSON.parse(String(launch?.init?.body))).toEqual({
      agent: 'claude', cwd: '/repos/web', permissionMode: 'default',
      name: 'Fix the flaky auth test', initialPrompt: 'Fix the flaky auth test\nIt fails on CI',
    });
    expect(onLaunched).toHaveBeenCalledWith({ id: 'session-new' });
    expect(calls.some((call) => call.url === '/api/runs')).toBe(false);
  });

  it('Structured mode keeps acceptance criteria, verification, budget and delivery, and submits a Run', async () => {
    const { calls, onSubmitted } = await mount(readiness('managed'));
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[name="start-work-mode"]')[1]!.click(); });
    for (const label of ['Acceptance criteria', 'Verification commands', 'Time limit', 'Turn limit', 'Delivery target']) {
      expect(host.textContent).toContain(label);
    }
    await type(field('What do you want done?') as HTMLTextAreaElement, 'Add rate limiting');
    await type(field('Acceptance criteria') as HTMLTextAreaElement, 'Returns 429\nHas tests');
    await submit();

    const run = calls.find((call) => call.url === '/api/runs');
    expect(JSON.parse(String(run?.init?.body))).toMatchObject({
      objective: 'Add rate limiting', acceptanceCriteria: ['Returns 429', 'Has tests'],
      repository: { id: '/repos/agentdeck' }, runtimePreference: ['codex', 'claude'],
      budget: { maxWallClockMs: 3_600_000, maxModelTurns: 50 }, requestedDeliveryResult: 'apply-to-repository',
    });
    expect(calls.findIndex((call) => call.init?.method === 'PUT')).toBeLessThan(calls.findIndex((call) => call.url === '/api/runs'));
    expect(onSubmitted).toHaveBeenCalledWith({ id: 'run-new' });
  });

  it('explains and refuses an agent whose installation cannot run structured work', async () => {
    await mount(readiness('compatibility-only'));
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[name="start-work-mode"]')[1]!.click(); });
    await choose(field('Agent') as HTMLSelectElement, 'claude');
    await type(field('What do you want done?') as HTMLTextAreaElement, 'Anything');
    await type(field('Acceptance criteria') as HTMLTextAreaElement, 'Done');

    expect(host.textContent).toContain('Compatibility only');
    expect(host.textContent).toContain('require Claude Code 2.1.208 or newer');
    expect(host.textContent).toContain('No selected agent can run structured work right now.');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
