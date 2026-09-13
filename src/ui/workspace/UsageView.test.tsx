// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo, Session } from '../../types.js';
import type { ModelNewsFeed, TokenTotals, UsageModelRow, UsageSessionRow, UsageSummary, UsageTimeseriesPoint } from '../../usage/types.js';
import { UsageStrip } from './UsageStrip.js';
import { UsageView } from './UsageView.js';
import { formatTokens, formatUsd } from './usageModel.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function totals(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return {
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20_000, cacheWriteTokens: 0, totalTokens: 21_500,
    costUsd: 1.25, inputCostUsd: 1, outputCostUsd: 0.25, unpricedTokens: 0, events: 3, ...overrides,
  };
}

const summary: UsageSummary = {
  periods: [
    { period: 'today', current: totals({ totalTokens: 2_400_000 }), previous: totals({ totalTokens: 1_200_000 }) },
    { period: 'week', current: totals(), previous: totals({ totalTokens: 0 }) },
    { period: 'month', current: totals({ costUsd: 42 }), previous: totals() },
    { period: 'year', current: totals(), previous: totals() },
  ],
  allTime: totals(),
  topModel: { model: 'claude-sonnet-5', provider: 'claude', totalTokens: 21_500 },
  indexedAt: new Date().toISOString(),
  indexing: false,
};

const timeseries: UsageTimeseriesPoint[] = [
  { bucket: '2026-09-11', claude: totals(), codex: totals({ events: 0, totalTokens: 0 }) },
  { bucket: '2026-09-12', claude: totals(), codex: totals() },
];

const models: UsageModelRow[] = [
  { ...totals(), model: 'claude-sonnet-5', provider: 'claude', share: 0.8, lastUsedAt: new Date().toISOString(), priced: true },
  { ...totals({ costUsd: 0 }), model: 'codex-auto-review', provider: 'codex', share: 0.2, lastUsedAt: new Date().toISOString(), priced: false },
];

const sessionRows: UsageSessionRow[] = [
  { ...totals({ costUsd: 9 }), provider: 'claude', sessionId: 'claude-abc', cwd: '/repos/agentdeck', models: ['claude-sonnet-5'], startedAt: '2026-09-12T10:00:00Z', lastActivityAt: '2026-09-12T11:00:00Z' },
  { ...totals({ unpricedTokens: 21_500 }), provider: 'codex', sessionId: 'codex-xyz', cwd: '/elsewhere/tool', models: ['codex-auto-review'], startedAt: '2026-09-11T10:00:00Z', lastActivityAt: '2026-09-11T11:00:00Z' },
];

const news: ModelNewsFeed = {
  items: [
    { id: 'n1', provider: 'anthropic', kind: 'launch', title: 'We launched Claude Fable 5.1.', url: 'https://example.com', publishedAt: '2026-09-01', fetchedAt: '2026-09-12' },
    { id: 'n2', provider: 'openai', kind: 'deprecation', title: 'GPT-5.4-Cyber', detail: 'gpt-5.4 retires soon', publishedAt: '2026-09-11', fetchedAt: '2026-09-12', affectsModels: ['gpt-5.4'] },
    { id: 'n3', provider: 'local', kind: 'first-seen', title: 'First used gpt-6-astra', publishedAt: '2026-09-03', fetchedAt: '2026-09-12' },
  ],
  lastFetchedAt: new Date().toISOString(),
};

function mockApi(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    '/api/usage/summary': summary, '/api/usage/timeseries': timeseries, '/api/usage/models': models,
    '/api/usage/sessions': sessionRows, '/api/usage/rate-limits': [{ provider: 'codex', planType: 'plus', primary: { usedPercent: 93, windowMinutes: 10080 }, observedAt: new Date().toISOString() }],
    '/api/usage/news': news, ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]!;
    const body = responses[path];
    return body instanceof Response ? body : new Response(JSON.stringify(body ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(node);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

const repo: Repo = { id: 'repo-1', path: '/repos/agentdeck', name: 'agentdeck', currentBranch: 'main' };

describe('usage formatting', () => {
  it('abbreviates tokens and dollars', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(21_500)).toBe('21.5K');
    expect(formatTokens(3_418_706_939)).toBe('3.42B');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1419.5)).toBe('$1,420');
  });
});

describe('UsageView', () => {
  it('renders period tiles, models, plan limits, sessions, and news once active', async () => {
    mockApi();
    const host = await render(<UsageView active onSelectSession={() => undefined} repos={[repo]} sessions={[]} />);
    const today = host.querySelector('[aria-label="Today"]');
    expect(today?.textContent).toContain('2.4M');
    expect(today?.textContent).toContain('100% vs last');
    expect(host.querySelector('[aria-label="This week"]')?.textContent).toContain('no prior data');
    expect(host.querySelector('[aria-label="Models"]')?.textContent).toContain('no price');
    expect(host.querySelector('[aria-label="Plan limits"]')?.textContent).toContain('93% used');
    expect(host.querySelector('.usage-limit.is-critical')).not.toBeNull();
    const rows = host.querySelectorAll('.usage-table tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('agentdeck');
    expect(rows[1]?.textContent).toContain('—');
    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Model news"]')?.textContent).toContain("You've used gpt-5.4");
  });

  it('does not fetch while inactive', async () => {
    const fetchMock = mockApi();
    await render(<UsageView active={false} onSelectSession={() => undefined} repos={[]} sessions={[]} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters the news feed and passes the provider filter to the API', async () => {
    const fetchMock = mockApi();
    const host = await render(<UsageView active onSelectSession={() => undefined} repos={[]} sessions={[]} />);
    const feed = host.querySelector('[aria-label="Model news"]')!;
    await act(async () => { (Array.from(feed.querySelectorAll('button')).find((button) => button.textContent === 'Deprecations') as HTMLButtonElement).click(); });
    expect(feed.querySelectorAll('.usage-news-item')).toHaveLength(1);
    await act(async () => { (Array.from(feed.querySelectorAll('button')).find((button) => button.textContent === 'Mine') as HTMLButtonElement).click(); });
    expect(feed.querySelectorAll('.usage-news-item')).toHaveLength(2);

    await act(async () => { (host.querySelector('[aria-label="Provider"] button:nth-child(3)') as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/usage/models?provider=codex'))).toBe(true);
  });

  it('opens the AgentDeck session behind a usage row', async () => {
    mockApi();
    const session = { id: 'deck-1', agentSessionId: 'claude-abc', origin: 'managed', agent: 'claude', cwd: '/repos/agentdeck', startedAt: '', lastActivityAt: '', status: 'idle', statusSource: 'hook' } as Session;
    const onSelectSession = vi.fn();
    const host = await render(<UsageView active onSelectSession={onSelectSession} repos={[repo]} sessions={[session]} />);
    await act(async () => { (host.querySelector('.usage-link') as HTMLButtonElement).click(); });
    expect(onSelectSession).toHaveBeenCalledWith(session);
  });

  it('shows an error when usage cannot load', async () => {
    mockApi({ '/api/usage/summary': new Response('{}', { status: 500 }) });
    const host = await render(<UsageView active onSelectSession={() => undefined} repos={[]} sessions={[]} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('request failed: 500');
  });
});

describe('UsageStrip', () => {
  it('shows a glance with the latest non-local headline and opens Usage', async () => {
    mockApi();
    const onOpen = vi.fn();
    const host = await render(<UsageStrip onOpen={onOpen} />);
    const strip = host.querySelector('.usage-strip') as HTMLButtonElement;
    expect(strip.textContent).toContain('2.4M');
    expect(strip.textContent).toContain('$42.00');
    expect(strip.textContent).toContain('claude-sonnet-5');
    expect(strip.textContent).toContain('We launched Claude Fable 5.1.');
    await act(async () => { strip.click(); });
    expect(onOpen).toHaveBeenCalled();
  });

  it('stays hidden when usage is unavailable', async () => {
    mockApi({ '/api/usage/summary': new Response('{}', { status: 404 }) });
    const host = await render(<UsageStrip onOpen={() => undefined} />);
    expect(host.querySelector('.usage-strip')).toBeNull();
  });
});
