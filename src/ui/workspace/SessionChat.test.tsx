// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session, SessionChatMessage } from '../../types.js';
import { TerminalWorkspace } from './TerminalWorkspace.js';
import { MobileWorkspace } from './MobileWorkspace.js';

vi.mock('../components/Terminal.js', () => ({ Terminal: () => <div>Terminal output</div> }));

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const session: Session = {
  id: 'session-1', origin: 'managed', agent: 'codex', cwd: '/repo',
  status: 'working', statusSource: 'hook', startedAt: '2026-09-01T00:00:00Z', lastActivityAt: '2026-09-01T00:00:00Z',
};
const message = (id: string, text: string, displayName = 'Alice'): SessionChatMessage => ({
  id, text, displayName, ts: `2026-09-01T00:00:0${id}Z`, authorKind: 'human', audience: 'chat',
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
async function render(selected = session, mobile = false) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(mobile
    ? <MobileWorkspace session={selected} sessions={[selected]} ws={null} wsReady={false} onError={vi.fn()} onSelect={vi.fn()} />
    : <TerminalWorkspace session={selected} sessions={[selected]} ws={null} wsReady={false} onError={vi.fn()} onFocusExternal={vi.fn()} />));
}
async function submit(text: string) {
  const input = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('admin shared session chat', () => {
  it.each([false, true])('shows each sender and posts both ordinary and @agent messages through shared chat (mobile=%s)', async (mobile) => {
    const rows = [message('1', 'I think the API is causing it.'), {
      ...message('2', 'Investigating now.', 'Codex'), authorKind: 'agent' as const,
    }];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/capabilities')) return json({ send: 'managed' });
      if (init?.method === 'POST') {
        const text = JSON.parse(String(init.body)).text as string;
        return json({ ...message('3', text, 'Admin'), ...(text.includes('@agent') ? { audience: 'agent', delivery: 'sent' } : {}) });
      }
      return json(rows);
    });
    vi.stubGlobal('fetch', fetcher);
    await render(session, mobile);
    expect(host.querySelector('[aria-label="Conversation"]')?.textContent).toContain('Alice');
    expect(host.textContent).toContain('I think the API is causing it.');
    expect(host.textContent).toContain('Codex');
    await submit('Can someone check this issue?');
    expect(host.textContent).toContain('Admin');
    expect(host.textContent).toContain('Can someone check this issue?');
    await submit('@agent investigate the API issue');
    expect(host.textContent).toContain('Sent to agent');
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual(['/api/sessions/session-1/chat', '/api/sessions/session-1/chat']);
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)).text)).toEqual(['Can someone check this issue?', '@agent investigate the API issue']);
  });

  it('continues receiving human posts after the agent exits', async () => {
    vi.useFakeTimers();
    let rows: SessionChatMessage[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => json(String(url).includes('/capabilities') ? { send: 'unavailable' } : rows)));
    await render({ ...session, status: 'exited' });
    rows = [message('1', 'Here is the follow-up.')];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.textContent).toContain('Here is the follow-up.');
    expect(host.querySelector('textarea')).not.toBeNull();
  });

  it('does not lose a successful post when an earlier poll completes later', async () => {
    vi.useFakeTimers();
    let finishPoll!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('/capabilities')) return json({ send: 'managed' });
      if (init?.method === 'POST') return json(message('1', 'Keep this post', 'Admin'));
      if (++reads === 2) return new Promise<Response>((resolve) => { finishPoll = resolve; });
      return json([]);
    }));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await submit('Keep this post');
    await act(async () => { finishPoll(json([])); });
    expect(host.textContent).toContain('Keep this post');
  });

  it('clears the previous conversation and draft when selecting a different session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => json(String(url).includes('/capabilities') ? { send: 'managed' } : String(url).includes('session-1') ? [message('1', 'Private to session one')] : [])));
    await render();
    const other = { ...session, id: 'session-2' };
    await act(async () => root.render(<TerminalWorkspace session={other} sessions={[session, other]} ws={null} wsReady={false} onError={vi.fn()} onFocusExternal={vi.fn()} />));
    expect(host.textContent).not.toContain('Private to session one');
    expect(host.querySelector('textarea')?.value).toBe('');
  });
});
