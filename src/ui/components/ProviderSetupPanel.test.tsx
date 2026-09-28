// @vitest-environment jsdom
// Issue #85: provider setup in the Mac app — install, sign in, readiness,
// and repair states. fetch is stubbed per route.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { repairFor, type ProviderReadinessState } from '../../provider-setup/readiness.js';
import type { ProviderSetupEntry, ProviderSetupView } from '../../provider-setup/service.js';
import { HomeProviderSetup, ProviderSetupPanel } from './ProviderSetupPanel.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

function entry(provider: 'claude' | 'codex', state: ProviderReadinessState | undefined, overrides: Partial<ProviderSetupEntry> = {}): ProviderSetupEntry {
  return {
    provider,
    name: provider === 'claude' ? 'Claude Code' : 'Codex',
    confirmedThisLaunch: true,
    ...(state ? {
      readiness: { provider, state, detail: `${provider} is ${state}.`, checkedAt: '2026-09-27T12:00:00.000Z' },
      repair: repairFor(provider, state),
    } : {}),
    ...overrides,
  };
}

function serve(view: ProviderSetupView, after: Record<string, ProviderSetupView> = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return json(after[url] ?? view);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(node); });
  await flush();
}

const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label);

describe('ProviderSetupPanel', () => {
  it('offers the official installer when Claude Code is missing and a guided page for Codex', async () => {
    const calls = serve({ providers: [entry('claude', 'missing-cli'), entry('codex', 'missing-cli')] });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toContain('Install Claude Code');
    expect(host.textContent).toMatch(/never sees or stores your password or API key/i);
    await act(async () => { button('Install Claude Code')!.click(); });
    await act(async () => { button('Open install page')!.click(); });
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([
      '/api/provider-setup/claude/install', '/api/provider-setup/codex/install-guide',
    ]));
  });

  it('guides a browser sign-in, reopens the page, and passes the fallback code on once', async () => {
    const signingIn = entry('claude', 'signed-out', {
      operation: { kind: 'sign-in', state: 'running', startedAt: '2026-09-27T12:00:00.000Z', browserPageAvailable: true, acceptsCode: true },
    });
    const calls = serve({ providers: [signingIn, entry('codex', 'missing-cli')] });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toContain('Finish signing in in your browser');
    await act(async () => { button('Open sign-in page')!.click(); });

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Sign-in code"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'abcdef123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Submit code')!.click(); });
    expect(calls.find((call) => call.url === '/api/provider-setup/claude/sign-in/code')?.body).toEqual({ code: 'abcdef123456' });
    expect(calls.some((call) => call.url === '/api/provider-setup/claude/sign-in/page')).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Sign-in code"]')!.value).toBe('');
  });

  it('shows actionable repair for an expired sign-in, a used-up allowance, and a failed check', async () => {
    serve({ providers: [entry('claude', 'expired'), entry('codex', 'allowance-reached')] });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toContain('Sign in to Claude Code again');
    expect(button('Sign in')).toBeDefined();
    expect(host.textContent).toContain('Plan allowance used up');
    expect(host.textContent).toContain('Signing in again will not help');
  });

  it('marks a result from before a restart as unconfirmed until it is checked again', async () => {
    serve({ providers: [entry('claude', 'ready', { confirmedThisLaunch: false }), entry('codex', undefined, { confirmedThisLaunch: false })] });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toMatch(/before AgentDeck restarted/);
  });

  it('shows a failed installer’s message', async () => {
    serve({ providers: [entry('claude', 'missing-cli', {
      operation: { kind: 'install', state: 'failed', startedAt: '2026-09-27T12:00:00.000Z', message: 'The Claude Code installer did not finish.' },
    }), entry('codex', 'missing-cli')] });
    await render(<ProviderSetupPanel />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('installer did not finish');
  });

  it('shows whether Claude may help with personal tasks, and checks the sandbox again on request', async () => {
    const off = { providers: [entry('claude', 'ready', { agentAccess: { state: 'off', reason: 'AgentDeck could not confirm that Claude Code stays sandboxed.' } }), entry('codex', 'missing-cli')] };
    const checking = { providers: [entry('claude', 'ready', { agentAccess: { state: 'checking' } }), entry('codex', 'missing-cli')] };
    const calls = serve(off, { '/api/provider-setup/claude/agent-access': checking });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toContain('Agent help for personal tasks is off');
    expect(host.textContent).toContain('could not confirm that Claude Code stays sandboxed');
    await act(async () => { button('Check sandbox again')!.click(); });
    expect(calls.map((call) => call.url)).toContain('/api/provider-setup/claude/agent-access');
    expect(host.textContent).toMatch(/Checking that Claude stays sandboxed/);
    await act(async () => { root.unmount(); });

    serve({ providers: [entry('claude', 'ready', { agentAccess: { state: 'on' } }), entry('codex', 'missing-cli')] });
    await render(<ProviderSetupPanel />);
    expect(host.textContent).toContain('Agent help for personal tasks is on');
  });
});

describe('HomeProviderSetup', () => {
  it('appears only while no provider is ready', async () => {
    serve({ providers: [entry('claude', 'signed-out'), entry('codex', 'missing-cli')] });
    await render(<HomeProviderSetup />);
    expect(host.textContent).toContain('Set up an AI provider');
    await act(async () => { root.unmount(); });

    serve({ providers: [entry('claude', 'signed-out'), entry('codex', 'ready')] });
    await render(<HomeProviderSetup />);
    expect(host.textContent).toBe('');
  });

  it('stays out of the way until the first check has answered', async () => {
    serve({ providers: [entry('claude', undefined, { confirmedThisLaunch: false }), entry('codex', undefined, { confirmedThisLaunch: false })] });
    await render(<HomeProviderSetup />);
    expect(host.textContent).toBe('');
  });
});
