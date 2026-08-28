import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import { TOKEN_HEADER } from '../../protocol.js';
import { MobileWorkspace, ReflowPane, nextReflowText, sendToMobileSession } from './MobileWorkspace.js';

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function fakeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  };
}

const session: Session = {
  id: 'sess-1',
  origin: 'managed',
  agent: 'claude',
  cwd: '/repos/agentdeck',
  startedAt: '2026-08-27T12:00:00.000Z',
  lastActivityAt: '2026-08-27T12:30:00.000Z',
  status: 'working',
  statusSource: 'output_heuristic',
};

const endedSession: Session = {
  ...session,
  id: 'ended-session',
  status: 'exited',
  statusSource: 'process_gone',
  endedAt: '2026-08-27T12:30:00.000Z',
};

describe('nextReflowText (frame → display-text reducer)', () => {
  it('adopts a reflow_text frame scoped to the current session', () => {
    const result = nextReflowText('old text', { t: 'reflow_text', sessionId: 'sess-1', text: 'new text' }, 'sess-1');
    expect(result).toBe('new text');
  });

  it('ignores a reflow_text frame for a different session', () => {
    const result = nextReflowText('old text', { t: 'reflow_text', sessionId: 'sess-2', text: 'new text' }, 'sess-1');
    expect(result).toBe('old text');
  });

  it('ignores frame types other than reflow_text', () => {
    const result = nextReflowText('old text', { t: 'session_removed', sessionId: 'sess-1' }, 'sess-1');
    expect(result).toBe('old text');
  });
});

describe('ReflowPane (renders reflowed text from a reflow_text frame)', () => {
  it('renders the text produced by applying a reflow_text frame through the reducer', () => {
    const applied = nextReflowText('', {
      t: 'reflow_text', sessionId: 'sess-1', text: 'agent output line one\nagent output line two',
    }, 'sess-1');
    const html = renderToStaticMarkup(createElement(ReflowPane, { text: applied }));
    expect(html).toContain('agent output line one');
    expect(html).toContain('agent output line two');
    // A <pre> preserves line breaks server-side; the actual screen-width
    // reflow at a narrow viewport is done by CSS (white-space: pre-wrap;
    // word-break: break-word — see workspace.css), which this static
    // render cannot exercise; that CSS behavior is not covered by this
    // test (no real browser/device available in this sandbox — see the
    // report for what needs manual/visual verification).
    expect(html).toContain('mobile-reflow');
  });

  it('shows a waiting placeholder before any frame has arrived', () => {
    const html = renderToStaticMarkup(createElement(ReflowPane, { text: '' }));
    expect(html).toContain('Waiting for output');
  });
});

describe('sendToMobileSession (composer → POST /api/sessions/:id/send via apiFetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/sessions/:id/send through apiFetch, carrying the tailnet token header', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'agentdeck.connection.token': 'phone-token' }));
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({ delivered: 'typed' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendToMobileSession(session, 'hello from the phone');

    expect(result).toEqual({ delivered: 'typed' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/sessions/${session.id}/send`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello from the phone' });
    expect(init?.headers).toMatchObject({ [TOKEN_HEADER]: 'phone-token' });
  });

  it('throws with the server-provided error when the send fails', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'session has ended' }), { status: 409 })));

    await expect(sendToMobileSession(session, 'hi')).rejects.toThrow('session has ended');
  });
});

describe('MobileWorkspace (static render)', () => {
  it('shows a session picker instead of the composer when no session is selected', () => {
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      onError: () => undefined,
      onSelect: () => undefined,
      session: null,
      sessions: [session],
      ws: null,
      wsReady: false,
    }));
    expect(html).toContain('Select a session');
    expect(html).toContain(session.id);
    expect(html).not.toContain('Message the agent');
  });

  it('renders the composer for a live session and hides it for an ended one', () => {
    const live = renderToStaticMarkup(createElement(MobileWorkspace, {
      onError: () => undefined,
      onSelect: () => undefined,
      session,
      sessions: [session],
      ws: null,
      wsReady: true,
    }));
    expect(live).toContain('Message the agent');

    const ended = renderToStaticMarkup(createElement(MobileWorkspace, {
      onError: () => undefined,
      onSelect: () => undefined,
      session: endedSession,
      sessions: [endedSession],
      ws: null,
      wsReady: true,
    }));
    expect(ended).not.toContain('Message the agent');
  });

  it('leaves an obvious slot for ticket 14\'s control keys', () => {
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      onError: () => undefined,
      onSelect: () => undefined,
      session,
      sessions: [session],
      ws: null,
      wsReady: true,
    }));
    expect(html).toContain('mobile-control-keys');
  });
});
