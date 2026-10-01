// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WindowViewPanel } from './WindowViewPanel.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<WindowViewPanel />); });
}

const IDLE = { permission: 'granted', window: null, live: null, lastEnded: null };

describe('WindowViewPanel (issue #91)', () => {
  it('explains denied Screen Recording permission and offers the fix', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(url); return json({ permission: 'denied', permissionHelp: 'help' }); }
      if (url === '/api/window-view') return json({ ...IDLE, permission: 'denied', permissionHelp: 'AgentDeck needs Screen Recording permission. Open System Settings › Privacy & Security › Screen Recording.' });
      return json({ error: 'unexpected' }, 500);
    }));
    await render();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('Privacy & Security › Screen Recording');
    expect(button('Choose a window…')).toBeUndefined();
    await act(async () => { button('Ask for permission')!.click(); });
    await act(async () => { button('Open Screen Recording settings')!.click(); });
    expect(posts).toEqual(['/api/window-view/permission', '/api/window-view/permission/settings']);
  });

  it('lists windows and shares only the one the owner picks', async () => {
    let selected: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/window-view/windows') return json([{ id: 101, app: 'TextEdit', title: 'Notes.txt' }, { id: 202, app: 'Safari', title: 'Bank' }]);
      if (url === '/api/window-view/select') {
        selected = JSON.parse(String(init?.body));
        return json({ ...IDLE, window: { app: 'TextEdit', title: 'Notes.txt' } });
      }
      if (url === '/api/window-view') return json(IDLE);
      return json({ error: 'unexpected' }, 500);
    }));
    await render();
    await act(async () => { button('Choose a window…')!.click(); });
    expect(container!.textContent).toContain('Safari — Bank');
    const share = [...container!.querySelectorAll('button')].filter((b) => b.textContent === 'Share');
    await act(async () => { share[0]!.click(); });
    expect(selected).toEqual({ windowId: 101 });
    expect(container!.textContent).toContain('Shared window: TextEdit — Notes.txt');
    expect(button('Stop sharing')).toBeDefined();
  });

  it('shows a visible indicator while a phone is viewing, with a way to stop it', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/window-view/stop' && init?.method === 'POST') {
        posts.push(url);
        return json({ ...IDLE, window: { app: 'TextEdit', title: 'Notes.txt' }, lastEnded: { reason: 'stopped-at-mac', message: 'Viewing was stopped on the Mac.', at: '2026-09-30T10:00:00.000Z', viewer: 'Sam’s iPhone' } });
      }
      if (url === '/api/window-view') return json({ ...IDLE, window: { app: 'TextEdit', title: 'Notes.txt' }, live: { viewer: 'Sam’s iPhone', window: { app: 'TextEdit', title: 'Notes.txt' }, startedAt: '2026-09-30T09:59:00.000Z' } });
      return json({ error: 'unexpected' }, 500);
    }));
    await render();
    const indicator = container!.querySelector('[aria-label="Phone viewing now"]');
    expect(indicator?.textContent).toContain('Sam’s iPhone is viewing TextEdit — Notes.txt');
    await act(async () => { button('Stop viewing')!.click(); });
    expect(posts).toEqual(['/api/window-view/stop']);
    expect(container!.querySelector('[aria-label="Phone viewing now"]')).toBeNull();
    expect(container!.textContent).toContain('Viewing was stopped on the Mac.');
  });
});
