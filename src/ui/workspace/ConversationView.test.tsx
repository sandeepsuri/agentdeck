// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../../sessions/conversation.js';
import type { Session } from '../../types.js';
import { ConversationView, groupTurns } from './ConversationView.js';

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
  it('shows your messages, the agent reply as rendered markdown, and its tool calls folded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ found: true, turns: [
      turn('1', 'user', 'Add dark mode'), turn('2', 'tool', 'rg theme', 'shell'), turn('3', 'assistant', 'Done — see `theme.css`.'),
    ] })));
    await mount({ session: session() });

    expect(container!.querySelector('.conversation-message.is-user')?.textContent).toBe('Add dark mode');
    expect(container!.querySelector('.conversation-message.is-assistant code')?.textContent).toBe('theme.css');
    expect(container!.querySelector('.conversation-tools summary')?.textContent).toBe('Used shell');
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
});
