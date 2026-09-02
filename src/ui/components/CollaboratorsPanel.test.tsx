// @vitest-environment jsdom
// Ticket 11 AC8: browser UI test for the admin's Collaborators panel —
// rendered standalone in a bare DOM with a fake fetch, same pattern
// ControlKeys.test.tsx uses. Exercises invitation issuance (AC1) and device
// revocation (AC5) through the real component, not just collaborators.ts's
// fetch wrappers (already covered directly in collaborators.test.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Repo } from '../../types.js';
import { CollaboratorsPanel } from './CollaboratorsPanel.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** React tracks the native input value setter to detect changes — a plain `.value =` assignment is invisible to it, so this uses the same prototype-setter trick React's own test utilities use. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(repos: Repo[] = []) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<CollaboratorsPanel repos={repos} />);
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('CollaboratorsPanel', () => {
  it('loads and lists collaborators with their devices on mount', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], devices: [
        { id: 'd1', collaboratorId: 'c1', deviceLabel: "Alice's phone", createdAt: '2026-01-01T00:00:00.000Z' },
      ] },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();

    expect(host.textContent).toContain('Alice');
    expect(host.textContent).toContain("Alice's phone");
    expect(fetchMock).toHaveBeenCalledWith('/api/collaborators', expect.anything());
  });

  it('shows "No collaborators yet." when the list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const host = await mount();
    expect(host.textContent).toContain('No collaborators yet.');
  });

  it('creates an invitation and displays the one-time code exactly once (AC1)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators' && (!init || init.method === undefined)) return jsonResponse([]);
      if (url === '/api/collaborators' && init?.method === 'POST') {
        return jsonResponse({
          collaborator: { id: 'c1', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [] },
          invitation: { id: 'inv-1', collaboratorId: 'c1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
          code: 'brand-new-one-time-code',
        }, 201);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const nameInput = host.querySelector('input[aria-label="Collaborator name"]') as HTMLInputElement;
    const createButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Create invitation')!;

    await act(async () => {
      setInputValue(nameInput, 'Bob');
    });
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(host.textContent).toContain('brand-new-one-time-code');
    expect(host.textContent).toContain('Bob');
  });

  it('revokes a device and removes it from the visible list', async () => {
    let listCall = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        listCall += 1;
        const devices = listCall === 1
          ? [{ id: 'd1', collaboratorId: 'c1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z' }]
          : [{ id: 'd1', collaboratorId: 'c1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-01-01T01:00:00.000Z' }];
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], devices }]);
      }
      if (url === '/api/collaborators/devices/d1/revoke' && init?.method === 'POST') {
        return jsonResponse({ id: 'd1', collaboratorId: 'c1', deviceLabel: 'phone', createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-01-01T01:00:00.000Z' });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    expect(host.textContent).toContain('phone');
    const revokeButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Revoke')!;

    await act(async () => {
      revokeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('button[aria-label="Revoke phone"]')).toBeNull();
    expect(host.textContent).toContain('phone — revoked');
  });

  it('offers a repository grant checkbox for every passed-in repo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }];
    const host = await mount(repos);
    expect(host.textContent).toContain('example');
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });
});
