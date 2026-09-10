// @vitest-environment jsdom
// A14 (parent #37): browser UI test for the Settings workspace's
// Profiles tab — rendered through a thin harness that calls useAccessData()
// exactly like SettingsWorkspace does, same pattern CollaboratorsPanel.test.tsx
// already used before the split. Exercises Profile browsing, creation, and
// the create-only replacement flow (ticket 55).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProfilesPanel } from './ProfilesPanel.js';
import { useAccessData } from './useAccessData.js';

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

/** Mirrors how SettingsWorkspace actually wires ProfilesPanel — access lives one level up. */
function Harness() {
  const access = useAccessData();
  return <ProfilesPanel access={access} />;
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<Harness />);
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

/** A14 redesign follow-up: creation sits behind a collapsed "New profile" toggle, so every test that needs the create form open must click it first. */
function openNewProfileForm(host: HTMLElement) {
  const toggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '+ New profile')!;
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ProfilesPanel', () => {
  it('shows "No Profiles yet." when the list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const host = await mount();
    expect(host.textContent).toContain('No Profiles yet.');
  });

  it('A14: puts creation behind a collapsed "New profile" action, after the existing-Profiles list', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/collaborators') return jsonResponse([]);
      if (url === '/api/profiles') return jsonResponse([{
        id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
        budget: { maxWallClockMs: 3_600_000 }, verificationIntent: { required: false, commands: [] },
        requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
      }]);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const nameInputHidden = () => Boolean((host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement).closest('[hidden]'));
    expect(nameInputHidden()).toBe(true); // collapsed by default
    const toggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '+ New profile')!;

    // the existing Profile's row and the "New profile" toggle both exist — the row comes first in document order
    const profileRow = Array.from(host.querySelectorAll('li')).find((li) => li.textContent?.includes('Standard Codex run'))!;
    expect(profileRow.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(nameInputHidden()).toBe(false);
  });

  it('A14: preserves an unsubmitted "New profile" draft when the form is collapsed and reopened', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const host = await mount();

    await act(async () => { openNewProfileForm(host); });
    const nameInput = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Draft profile name'); });

    const toggle = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('New profile') || b.textContent?.includes('Close new profile form'))!;
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // collapse
    expect(nameInput.closest('[hidden]')).not.toBeNull(); // stays mounted, just hidden
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // reopen

    const nameInputAfter = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    expect(nameInputAfter.closest('[hidden]')).toBeNull();
    expect(nameInputAfter.value).toBe('Draft profile name');
  });

  it('ticket 12 AC1: creates a Profile through the create form', async () => {
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
    await act(async () => { openNewProfileForm(host); });
    const nameInput = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Standard Codex run'); });
    const createButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Create Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

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
