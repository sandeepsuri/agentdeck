// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FolderAccessPanel, type FolderAccessView } from './FolderAccessPanel.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const empty: FolderAccessView = { roots: [], chosen: false, enforced: true, launchedByApp: true, canPick: true };
const chosen = (paths: string[]): FolderAccessView => ({ ...empty, chosen: true, roots: paths.map((path) => ({ path, exists: true })) });

async function mount(onChange = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<FolderAccessPanel onChange={onChange} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return onChange;
}
const button = (label: string) => [...container!.querySelectorAll('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label)!;
async function click(element: HTMLElement) {
  await act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('FolderAccessPanel', () => {
  it('explains that nothing is visible yet, then adds a folder from the native picker', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/settings/access/pick' && init?.method === 'POST') return json(chosen(['/Users/me/Code']));
      return json(empty);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChange = await mount();
    expect(container!.textContent).toContain("AgentDeck can't see any repositories yet");

    await click(button('Choose Folder…'));

    expect(container!.textContent).toContain('/Users/me/Code');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('removes a folder and shows the server refusal for a too-broad one', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { roots: string[] };
        bodies.push(body);
        if (body.roots.includes('/Users/me')) return json({ error: 'That folder is too broad to grant.' }, 400);
        return json(chosen(body.roots));
      }
      return json(chosen(['/Users/me/Code', '/Users/me/Work']));
    }));
    await mount();

    await click(button('Remove /Users/me/Work'));
    expect(bodies).toEqual([{ roots: ['/Users/me/Code'] }]);
    expect(container!.textContent).not.toContain('/Users/me/Work');

    const input = container!.querySelector('input[aria-label="Folder path"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '/Users/me');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Add'));
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('too broad');
  });
});
