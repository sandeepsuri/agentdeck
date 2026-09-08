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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/profiles') return jsonResponse([]);
      return jsonResponse([
        { id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: [], devices: [
          { id: 'd1', collaboratorId: 'c1', deviceLabel: "Alice's phone", createdAt: '2026-01-01T00:00:00.000Z' },
        ] },
      ]);
    });
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
          collaborator: { id: 'c1', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] },
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
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices }]);
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

  it('removes a collaborator from the roster after confirming', async () => {
    let listCall = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        listCall += 1;
        return jsonResponse(listCall === 1
          ? [{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] }]
          : []);
      }
      if (url === '/api/collaborators/c1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));

    const host = await mount();
    expect(host.textContent).toContain('Alice');
    const removeButton = host.querySelector('button[aria-label="Remove Alice"]') as HTMLButtonElement;

    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('No collaborators yet.');
  });

  it('does not remove a collaborator when the confirmation is declined', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => false));

    const host = await mount();
    const removeButton = host.querySelector('button[aria-label="Remove Alice"]') as HTMLButtonElement;

    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalledWith('/api/collaborators/c1', expect.objectContaining({ method: 'DELETE' }));
    expect(host.textContent).toContain('Alice');
  });

  it('offers a repository grant checkbox for every passed-in repo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }];
    const host = await mount(repos);
    expect(host.textContent).toContain('example');
    expect(host.querySelectorAll('.collaborators-repo-grants input[type="checkbox"]')).toHaveLength(1);
  });

  it('ticket 51: opens an edit-access editor seeded with the collaborator\'s current grants', async () => {
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }, { id: 'repo-2', name: 'other', path: '/tmp/other' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: [], devices: [] }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount(repos);
    const editButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Edit access')!;
    await act(async () => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const checkboxes = host.querySelectorAll('.collaborators-edit-grants .collaborators-repo-grants input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]!.checked).toBe(true);
    expect(checkboxes[1]!.checked).toBe(false);
  });

  it('ticket 51: cancel discards the draft without calling the API', async () => {
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount(repos);
    const editButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Edit access')!;
    await act(async () => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const checkbox = host.querySelector('.collaborators-edit-grants .collaborators-repo-grants input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });
    expect(checkbox.checked).toBe(true);

    const cancelButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    await act(async () => { cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.querySelector('.collaborators-edit-grants')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/collaborators/c1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('ticket 51: saves grants through PATCH, then reloads and displays exactly what the server returned', async () => {
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }, { id: 'repo-2', name: 'other', path: '/tmp/other' }];
    let patchBody: unknown = null;
    let listCall = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        listCall += 1;
        // The server is the source of truth for the resulting grants — the post-save reload reflects its own de-duped view, not the checked boxes.
        const grantedRepositoryIds = listCall === 1 ? ['repo-1'] : ['repo-1', 'repo-2'];
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds, grantedProfileIds: ['profile-9'], devices: [] }]);
      }
      if (url === '/api/collaborators/c1' && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body as string);
        return jsonResponse({ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1', 'repo-2'], grantedProfileIds: ['profile-9'] });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount(repos);
    const editButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Edit access')!;
    await act(async () => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const checkboxes = Array.from(host.querySelectorAll('.collaborators-edit-grants .collaborators-repo-grants input[type="checkbox"]')) as HTMLInputElement[];
    await act(async () => { checkboxes[1]!.click(); }); // grant repo-2 in addition to repo-1

    const saveButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save access')!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(patchBody).toEqual({ grantedRepositoryIds: ['repo-1', 'repo-2'], grantedProfileIds: ['profile-9'] });
    // multiple-grant preservation: the untouched Profile grant survived the round trip
    expect(host.textContent).toContain('2 repositories');
    expect(host.textContent).toContain('1 profile');
    expect(host.querySelector('.collaborators-edit-grants')).toBeNull();
  });

  it('ticket 51: a failed save keeps the editor open with an error and does not report false success', async () => {
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        return jsonResponse([{ id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] }]);
      }
      if (url === '/api/collaborators/c1' && init?.method === 'PATCH') {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount(repos);
    const editButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Edit access')!;
    await act(async () => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const saveButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save access')!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(host.querySelector('.collaborators-edit-grants')).not.toBeNull();
    expect(host.textContent).toContain('Unable to update access. Nothing was changed.');
    expect(host.textContent).toContain('0 repositories');
  });

  it('ticket 51: Repository access lists which collaborators are granted each repository, derived from the roster', async () => {
    const repos: Repo[] = [{ id: 'repo-1', name: 'example', path: '/tmp/example' }, { id: 'repo-2', name: 'other', path: '/tmp/other' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') {
        return jsonResponse([
          { id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: [], devices: [] },
          { id: 'c2', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] },
        ]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount(repos);

    const accessSection = host.querySelector('.collaborators-access-list')!;
    expect(accessSection).not.toBeNull();
    expect(accessSection.textContent).toContain('example');
    expect(accessSection.textContent).toContain('Alice');
    expect(accessSection.textContent).not.toContain('Bob');
    expect(accessSection.textContent).toContain('other');
    expect(accessSection.textContent).toContain('0 collaborators granted');
  });

  it('ticket 12 AC1: creates a Profile and offers it as an invite-time grant checkbox', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse([]);
      if (url === '/api/profiles' && (!init || init.method === undefined)) return jsonResponse([]);
      if (url === '/api/profiles' && init?.method === 'POST') {
        return jsonResponse({
          id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
          budget: { maxWallClockMs: 3_600_000 }, verificationIntent: { required: false, commands: [] },
          requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
        }, 201);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const nameInput = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Standard Codex run'); });
    const createButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Create Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(host.querySelectorAll('.collaborators-profile-grants input[type="checkbox"]')).toHaveLength(1);
    expect(host.textContent).toContain('Standard Codex run');
  });

  const sourceProfile = {
    id: 'profile-1',
    name: 'Standard Codex run',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 3_600_000, maxModelTurns: 25 },
    verificationIntent: { required: true, commands: ['npm test'] },
    requestedDeliveryResult: 'pull-request',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('ticket 55: lists existing Profiles with their actual runtime, budget, verification, and delivery fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse([]);
      if (url === '/api/profiles') return jsonResponse([sourceProfile]);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();

    expect(host.textContent).toContain('Standard Codex run');
    expect(host.textContent).toContain('60 min wall clock');
    expect(host.textContent).toContain('verification required (1)');
    expect(host.textContent).toContain('Open draft pull request');
    expect(host.textContent).toContain('npm test');
    expect(host.textContent).toContain('Model turns');
    expect(host.querySelector('button[aria-label="Create new from Standard Codex run"]')).not.toBeNull();
  });

  it('ticket 55: "Create new from this Profile" seeds every actual field from the source Profile, and submits them unchanged', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse([]);
      if (url === '/api/profiles' && (!init || init.method === undefined)) return jsonResponse([sourceProfile]);
      if (url === '/api/profiles' && init?.method === 'POST') {
        return jsonResponse({ id: 'profile-2', ...JSON.parse(init.body as string), createdAt: '2026-01-02T00:00:00.000Z' }, 201);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const cloneButton = host.querySelector('button[aria-label="Create new from Standard Codex run"]') as HTMLButtonElement;
    await act(async () => { cloneButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const nameInput = host.querySelector('input[aria-label="New profile name"]') as HTMLInputElement;
    expect(nameInput.value).toBe('Standard Codex run copy');
    const runtimeCheckboxes = host.querySelectorAll('.collaborators-subpanel .collaborators-chip-row input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(runtimeCheckboxes[0]!.checked).toBe(true); // codex, from the source Profile
    expect(runtimeCheckboxes[1]!.checked).toBe(false); // claude was never in runtimePreference
    const wallClockInput = host.querySelector('.collaborators-subpanel input[type="number"]') as HTMLInputElement;
    expect(wallClockInput.value).toBe('60');
    const deliverySelect = host.querySelector('select[aria-label="Requested delivery result"]') as HTMLSelectElement;
    expect(deliverySelect.value).toBe('pull-request');
    const verifyCheckbox = host.querySelector('.collaborators-subpanel .collaborators-verify-toggle input') as HTMLInputElement;
    expect(verifyCheckbox.checked).toBe(true);
    const commandsTextarea = host.querySelector('.collaborators-subpanel textarea') as HTMLTextAreaElement;
    expect(commandsTextarea.value).toBe('npm test');
    const modelTurnsInput = host.querySelector('input[aria-label="Model turns"]') as HTMLInputElement;
    expect(modelTurnsInput.value).toBe('25');

    const createButton = Array.from(host.querySelectorAll('.collaborators-subpanel button')).find((b) => b.textContent === 'Create new from this Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/profiles' && (init as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse((postCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      name: 'Standard Codex run copy',
      runtimePreference: ['codex'],
      budget: { maxWallClockMs: 3_600_000, maxModelTurns: 25 },
      verificationIntent: { required: true, commands: ['npm test'] },
      requestedDeliveryResult: 'pull-request',
    });

    // the original Profile is untouched — still present, and nothing was ever sent to a per-Profile URL (create-only, no update route)
    expect(host.textContent).toContain('Standard Codex run');
    expect(fetchMock.mock.calls.some(([input]) => /^\/api\/profiles\/.+/.test(String(input)))).toBe(false);
  });

  it('ticket 55: Cancel closes the "Create new from this Profile" form without creating anything', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse([]);
      if (url === '/api/profiles') return jsonResponse([sourceProfile]);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const cloneButton = host.querySelector('button[aria-label="Create new from Standard Codex run"]') as HTMLButtonElement;
    await act(async () => { cloneButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.querySelector('.collaborators-subpanel')).not.toBeNull();

    const cancelButton = Array.from(host.querySelectorAll('.collaborators-subpanel button')).find((b) => b.textContent === 'Cancel')!;
    await act(async () => { cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.querySelector('.collaborators-subpanel')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/profiles', expect.objectContaining({ method: 'POST' }));
  });

  it('ticket 55: reassigning collaborator grants after cloning is a separate explicit action, touching only selected collaborators', async () => {
    const collaboratorsFixture = [
      { id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: ['repo-1'], grantedProfileIds: ['profile-1', 'profile-9'], devices: [] },
      { id: 'c2', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [], devices: [] },
    ];
    const patchCalls: { id: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse(collaboratorsFixture);
      if (url === '/api/profiles' && (!init || init.method === undefined)) return jsonResponse([sourceProfile]);
      if (url === '/api/profiles' && init?.method === 'POST') {
        return jsonResponse({
          id: 'profile-2', name: 'Standard Codex run copy', runtimePreference: ['codex'],
          budget: { maxWallClockMs: 3_600_000, maxModelTurns: 25 }, verificationIntent: { required: true, commands: ['npm test'] },
          requestedDeliveryResult: 'pull-request', createdAt: '2026-01-02T00:00:00.000Z',
        }, 201);
      }
      const match = /^\/api\/collaborators\/(.+)$/.exec(url);
      if (match && init?.method === 'PATCH') {
        patchCalls.push({ id: match[1]!, body: JSON.parse(init.body as string) });
        return jsonResponse({ ...collaboratorsFixture.find((c) => c.id === match[1]), ...JSON.parse(init.body as string) });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const cloneButton = host.querySelector('button[aria-label="Create new from Standard Codex run"]') as HTMLButtonElement;
    await act(async () => { cloneButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const createButton = Array.from(host.querySelectorAll('.collaborators-subpanel button')).find((b) => b.textContent === 'Create new from this Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const reassignPanel = Array.from(host.querySelectorAll('.collaborators-subpanel'))
      .find((el) => el.textContent?.includes('Update collaborator grants'))!;
    expect(reassignPanel.textContent).toContain('Alice');
    expect(reassignPanel.textContent).not.toContain('Bob'); // Bob was never granted the source Profile

    const checkbox = reassignPanel.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false); // nothing pre-selected — the admin must opt in explicitly
    expect(patchCalls).toHaveLength(0);

    await act(async () => { checkbox.click(); });
    const updateButton = Array.from(reassignPanel.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Update selected to'))!;
    await act(async () => {
      updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // Alice's unrelated Repository grant and other Profile grant both survive the swap
    expect(patchCalls).toEqual([{ id: 'c1', body: { grantedProfileIds: ['profile-2', 'profile-9'] } }]);
  });

  it('ticket 55: a partial grant-reassignment failure is shown per collaborator without deleting or hiding the new Profile', async () => {
    const collaboratorsFixture = [
      { id: 'c1', displayName: 'Alice', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: ['profile-1'], devices: [] },
      { id: 'c2', displayName: 'Carol', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: ['profile-1'], devices: [] },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse(collaboratorsFixture);
      if (url === '/api/profiles' && (!init || init.method === undefined)) return jsonResponse([sourceProfile]);
      if (url === '/api/profiles' && init?.method === 'POST') {
        return jsonResponse({
          id: 'profile-2', name: 'Standard Codex run copy', runtimePreference: ['codex'],
          budget: { maxWallClockMs: 3_600_000, maxModelTurns: 25 }, verificationIntent: { required: true, commands: ['npm test'] },
          requestedDeliveryResult: 'pull-request', createdAt: '2026-01-02T00:00:00.000Z',
        }, 201);
      }
      if (url === '/api/collaborators/c1' && init?.method === 'PATCH') {
        return jsonResponse({ ...collaboratorsFixture[0], grantedProfileIds: ['profile-2'] });
      }
      if (url === '/api/collaborators/c2' && init?.method === 'PATCH') {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const cloneButton = host.querySelector('button[aria-label="Create new from Standard Codex run"]') as HTMLButtonElement;
    await act(async () => { cloneButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const createButton = Array.from(host.querySelectorAll('.collaborators-subpanel button')).find((b) => b.textContent === 'Create new from this Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const reassignPanel = Array.from(host.querySelectorAll('.collaborators-subpanel'))
      .find((el) => el.textContent?.includes('Update collaborator grants'))!;
    const checkboxes = Array.from(reassignPanel.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    await act(async () => { checkboxes.forEach((checkbox) => checkbox.click()); });

    const updateButton = Array.from(reassignPanel.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Update selected to'))!;
    await act(async () => {
      updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(reassignPanel.textContent).toContain('Updated to Standard Codex run copy');
    expect(reassignPanel.textContent).toContain('Unable to update — still granted Standard Codex run');
    // the failure never rolls back or hides the newly created replacement Profile
    expect(host.textContent).toContain('Standard Codex run copy');
  });
});
