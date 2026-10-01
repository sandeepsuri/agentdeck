// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../../sessions/conversation.js';
import type { Session } from '../../types.js';
import { ConversationView, groupTurns } from './ConversationView.js';
import { TerminalWorkspace } from './TerminalWorkspace.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

const turn = (id: string, role: ConversationTurn['role'], text: string, toolName?: string): ConversationTurn =>
  ({ id, role, text, ts: '2026-09-27T20:00:00Z', ...(toolName ? { toolName } : {}) });
const session = (overrides: Partial<Session> = {}) => ({
  id: 's1', origin: 'managed', agent: 'codex', cwd: '/x', startedAt: '', lastActivityAt: '', status: 'idle', statusSource: 'hook', ...overrides,
}) as Session;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(props: { session: Session; onOpenTerminal?: () => void }) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ConversationView onOpenTerminal={props.onOpenTerminal ?? (() => {})} session={props.session} />));
  await flush();
}

describe('groupTurns', () => {
  it('folds consecutive tool calls into one group between messages', () => {
    const items = groupTurns([turn('1', 'user', 'hi'), turn('2', 'tool', 'ls', 'shell'), turn('3', 'tool', 'cat', 'shell'), turn('4', 'assistant', 'done')]);
    expect(items.map((item) => (item.kind === 'tools' ? `tools:${item.turns.length}` : item.turn.role))).toEqual(['user', 'tools:2', 'assistant']);
  });
});

describe('ConversationView', () => {
  it('keeps a draft and a pending send when switching Work session tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? json({ delivered: 'typed' }) : json({ found: false, turns: [] })));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const selected = session();
    await act(async () => root!.render(<TerminalWorkspace session={selected} sessions={[selected]} ws={null}
      wsReady={false} onError={() => {}} onFocusExternal={() => {}} />));
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'draft text');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const tab = (label: string) => [...container!.querySelectorAll('.session-view-tabs button')]
      .find((button) => button.textContent === label) as HTMLButtonElement;
    await act(async () => tab('Activity').click());
    await act(async () => tab('Conversation').click());
    expect(container.querySelector('textarea')!.value).toBe('draft text');
    await act(async () => root!.render(<div>Another Work page</div>));
    await act(async () => root!.render(<TerminalWorkspace session={selected} sessions={[selected]} ws={null}
      wsReady={false} onError={() => {}} onFocusExternal={() => {}} />));
    expect(container.querySelector('textarea')!.value).toBe('draft text');
    await act(async () => container!.querySelector('.conversation-composer')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    await act(async () => tab('Terminal').click());
    await act(async () => tab('Conversation').click());
    expect(container.querySelector('.conversation-message.is-pending')?.textContent).toBe('draft text');
  });

  it('shows your messages, the agent reply as rendered markdown, and its tool calls folded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ found: true, turns: [
      turn('1', 'user', 'Add dark mode'), turn('2', 'tool', 'rg theme', 'shell'), turn('3', 'assistant', 'Done — see `theme.css`.'),
    ] })));
    await mount({ session: session() });

    expect(container!.querySelector('.conversation-message.is-user')?.textContent).toBe('Add dark mode');
    expect(container!.querySelector('.conversation-message.is-assistant code')?.textContent).toBe('theme.css');
    expect(container!.querySelector('.conversation-tools summary')?.textContent).toBe('Used shell');
  });

  it('shows an image the agent looked at inline, fetched by its id, and opens it full size', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/images/')
      ? json({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
      : json({ found: true, turns: [{ id: 'img-3-0', role: 'image', text: 'login-failed.png', image: { id: 'img-3-0', mediaType: 'image/png' }, ts: '2026-09-27T20:00:00Z' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await mount({ session: session() });
    await flush();

    const image = container!.querySelector<HTMLImageElement>('.conversation-image img');
    expect(image?.src).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(image?.alt).toBe('login-failed.png');
    expect(container!.querySelector('.conversation-image figcaption')?.textContent).toBe('login-failed.png');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/sessions/s1/images/img-3-0');
    const button = container!.querySelector<HTMLButtonElement>('.conversation-image button')!;
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('says so when an image cannot be sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/images/')
      ? json({ error: 'This image is too large to show here.' }, 413)
      : json({ found: true, turns: [{ id: 'img-9-0', role: 'image', text: '', image: { id: 'img-9-0', mediaType: 'image/png' }, ts: '2026-09-27T20:00:00Z' }] })));
    await mount({ session: session({ id: 's2' }) });
    await flush();
    expect(container!.querySelector('.conversation-image-placeholder')?.textContent).toBe('This image is too large to show here.');
  });

  it('explains an empty conversation before the agent has written a transcript', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ found: false, turns: [] })));
    await mount({ session: session() });
    expect(container!.textContent).toContain('hasn’t written anything for this session yet');
  });

  it('sends on Enter through the session send route and shows the message until the transcript has it', async () => {
    const posts: unknown[] = [];
    let turns: ConversationTurn[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url: String(input), body: JSON.parse(String(init.body)) }); return json({ delivered: 'typed' }); }
      return json({ found: true, turns });
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount({ session: session() });

    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Ship it');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();

    expect(posts).toEqual([{ url: '/api/sessions/s1/send', body: { text: 'Ship it' } }]);
    expect(container!.querySelector('.conversation-message.is-pending')?.textContent).toBe('Ship it');

    turns = [turn('1', 'user', 'Ship it')];
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(container!.querySelector('.is-pending')).toBeNull();
    expect(container!.querySelectorAll('.conversation-message.is-user')).toHaveLength(1);
  });

  it('answers the agent’s open question from a card instead of the Terminal', async () => {
    const posts: unknown[] = [];
    const question = { id: 'toolu_1', delivery: 'menu', canAnswer: true, questions: [
      { question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green', description: 'Leafy' }] },
      { question: 'Pick toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Ham' }] },
    ] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url: String(input), body: JSON.parse(String(init.body)) }); return json({ delivered: 'typed' }); }
      return json({ found: true, turns: [], question });
    }));
    await mount({ session: session({ agent: 'claude', status: 'waiting_input' }) });

    const card = container!.querySelector('form.conversation-question')!;
    expect(card.textContent).toContain('Claude is asking');
    expect(container!.textContent).not.toContain('it may be asking for approval');
    const send = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Send answer')!;
    expect(send.disabled).toBe(true);

    const options = card.querySelectorAll<HTMLInputElement>('.conversation-question-option input');
    await act(async () => options[1]!.click());
    await act(async () => options[2]!.click());
    await act(async () => options[3]!.click());
    const other = card.querySelectorAll<HTMLInputElement>('.conversation-question-other')[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(other, 'Olives');
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(send.disabled).toBe(false);
    await act(async () => card.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();

    expect(posts).toEqual([{ url: '/api/sessions/s1/conversation/answer', body: {
      questionId: 'toolu_1', answers: [{ selected: [1] }, { selected: [0, 1], other: 'Olives' }],
    } }]);
    expect(container!.querySelector('form.conversation-question')).toBeNull();
  });

  it('sends a question it cannot answer to the Terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ found: true, turns: [], question: {
      id: 'toolu_1', delivery: 'menu', canAnswer: false, questions: [{ question: 'Pick', multiSelect: false, options: [{ label: 'A' }] }],
    } })));
    await mount({ session: session() });
    expect(container!.querySelector('.conversation-question fieldset')!.hasAttribute('disabled')).toBe(true);
    expect(container!.querySelector('.conversation-question-note')?.textContent).toContain('answer it there');
  });

  it('points to the Terminal when the agent is waiting for an approval, and disables the composer once ended', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ found: true, turns: [] })));
    const onOpenTerminal = vi.fn();
    await mount({ session: session({ status: 'waiting_input' }), onOpenTerminal });
    const open = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Open Terminal')!;
    await act(async () => open.click());
    expect(onOpenTerminal).toHaveBeenCalled();

    act(() => root!.unmount());
    root = null;
    await mount({ session: session({ status: 'exited' }) });
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
  });

  it('opens a skill picker on "/", filters it as you type, and fills in the picked skill before sending', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ delivered: 'typed' }); }
      if (url.endsWith('/skills')) return json({ skills: [
        { name: 'grill-me', description: 'Interview me about a plan', source: 'user', kind: 'skill' },
        { name: 'implement', description: 'Build a ticket end to end', source: 'project', kind: 'skill' },
        { name: 'to-tickets', description: 'Split work so each piece can implement one slice', source: 'user', kind: 'skill' },
      ] });
      return json({ found: true, turns: [] });
    }));
    await mount({ session: session({ agent: 'claude' }) });
    const textarea = container!.querySelector('textarea')!;
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const press = (key: string) => act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    const options = () => [...container!.querySelectorAll('.slash-menu [role="option"] strong')].map((option) => option.textContent);

    await type('/');
    await flush();
    expect(options()).toEqual(['/grill-me', '/implement', '/to-tickets']);

    await type('/imp');
    expect(options()).toEqual(['/implement', '/to-tickets']);
    expect(textarea.getAttribute('aria-activedescendant')).toBe(container!.querySelector('[role="option"][aria-selected="true"]')!.id);

    await press('Enter');
    expect(textarea.value).toBe('/implement ');
    expect(container!.querySelector('.slash-menu')).toBeNull();
    expect(posts).toEqual([]);

    await type('/implement #81');
    await press('Enter');
    await flush();
    expect(posts).toEqual([{ text: '/implement #81' }]);

    await type('/grill-me');
    await press('Enter');
    await flush();
    expect(posts).toEqual([{ text: '/implement #81' }, { text: '/grill-me' }]);

    await type('/zzz');
    expect(container!.querySelector('.slash-menu-empty')?.textContent).toContain('sends it as typed');
    await press('Escape');
    expect(container!.querySelector('.slash-menu')).toBeNull();
  });

  it('keeps the skill picker out of Codex sessions', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json({ found: true, turns: [] }));
    vi.stubGlobal('fetch', fetch);
    await mount({ session: session({ agent: 'codex' }) });
    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.querySelector('.slash-menu')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/skills'))).toBe(false);
  });
});
