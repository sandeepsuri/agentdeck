// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OwnerPhonesPanel } from './OwnerPhonesPanel.js';

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

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<OwnerPhonesPanel />); });
}

const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('OwnerPhonesPanel phone access', () => {
  it('offers to turn on phone access in the Mac app instead of failing to pair', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/owner-devices') return json([]);
      if (url === '/api/owner-pairing/availability') return json({ state: 'off', canToggle: true, phoneAccess: false });
      if (url === '/api/owner-pairing/phone-access' && init?.method === 'POST') return json({ restarting: true });
      return json({ error: 'unexpected' }, 500);
    });
    vi.stubGlobal('fetch', fetch);
    await render();
    expect(button('Pair a phone')?.disabled).toBe(true);
    await act(async () => { button('Turn on phone access')!.click(); });
    expect(fetch).toHaveBeenCalledWith('/api/owner-pairing/phone-access', expect.objectContaining({ body: JSON.stringify({ enabled: true }) }));
    expect(container!.textContent).toContain('Restarting AgentDeck…');
  });

  it("shows the server's reason when pairing can't start", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/owner-devices') return json([]);
      if (url === '/api/owner-pairing/availability') return json({ error: 'gone' }, 404);
      return json({ error: 'A Tailscale MagicDNS name is required to pair a phone.' }, 409);
    }));
    await render();
    await act(async () => { button('Pair a phone')!.click(); });
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('A Tailscale MagicDNS name is required to pair a phone.');
  });

  it('names what a phone asked for in its activity, including personal-task decisions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/owner-devices') return json([{ id: 'phone-1', label: 'Phone', createdAt: '2026-09-28T10:00:00.000Z' }]);
      if (url === '/api/owner-pairing/availability') return json({ state: 'ready', canToggle: false, phoneAccess: true });
      if (url === '/api/owner-devices/phone-1/audit') return json([
        { id: 'a2', deviceId: 'phone-1', action: 'filing-approve', targetId: 'task-1', createdAt: '2026-09-28T10:02:00.000Z' },
        { id: 'a1', deviceId: 'phone-1', action: 'personal-task-submit', targetId: 'task-1', createdAt: '2026-09-28T10:01:00.000Z' },
      ]);
      return json({ error: 'unexpected' }, 500);
    }));
    await render();
    await act(async () => { button('View activity')!.click(); });
    const rows = [...container!.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows[0]).toContain('Approved filing plan for task task-1');
    expect(rows[1]).toContain('Asked for personal task task-1');
  });
});
