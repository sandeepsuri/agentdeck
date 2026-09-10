// @vitest-environment jsdom
// A14 (parent #37): the Settings workspace's General/Profiles/
// Collaborators tabs, rendered as a page in the Admin shell's main content
// area rather than a modal. Every panel stays mounted across a tab switch
// (only `hidden` toggles), so this focuses on what that buys: an unsaved
// draft, a freshly issued one-time invitation code, and a just-created
// Profile all survive — or become visible — across tabs, exactly as the
// redesign slice requires. It also covers the page-vs-modal shape itself
// (no backdrop/dialog role, a working "Back to workspace" action) and the
// Profiles tab's collapsed "New profile" toggle. Per-panel mutation flows
// (create Profile, invite collaborator, revoke a device, …) are already
// covered directly in ProfilesPanel.test.tsx and CollaboratorsPanel.test.tsx;
// this file only exercises what changes once those panels sit behind shared
// tabs in one page.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsWorkspace } from './SettingsWorkspace.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(onBack: () => void = () => {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<SettingsWorkspace onBack={onBack} repos={[]} />);
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

/** Every SettingsWorkspace test needs these four GETs satisfied at minimum; mutation-specific routes are layered on by each test. */
function baseFetchMock(overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const overridden = overrides(url, init);
    if (overridden) return overridden;
    if (url === '/api/models') return jsonResponse([{ id: 'model-1', displayName: 'Model One', billing: 'subscription', available: true }]);
    if (url === '/api/settings') return jsonResponse({ openaiKeyConfigured: false, defaultModel: '' });
    if (url === '/api/collaborators') return jsonResponse([]);
    if (url === '/api/profiles') return jsonResponse([]);
    return jsonResponse([]);
  });
}

function tabButton(host: HTMLElement, label: string) {
  return Array.from(host.querySelectorAll('[role="tab"]')).find((b) => b.textContent === label) as HTMLButtonElement;
}

/** A14: the "New profile" toggle on the Profiles tab — its `aria-expanded` state makes it findable whether it currently reads "+ New profile" or "Close new profile form". */
function newProfileToggle(host: HTMLElement) {
  return host.querySelector('button[aria-expanded]') as HTMLButtonElement;
}

function openNewProfileForm(host: HTMLElement) {
  newProfileToggle(host).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('SettingsWorkspace', () => {
  it('A14: renders as a page in the main content area, not a modal — no backdrop/dialog role, and a working "Back to workspace" action', async () => {
    vi.stubGlobal('fetch', baseFetchMock());
    let backCount = 0;
    const host = await mount(() => { backCount += 1; });

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-modal]')).toBeNull();
    expect(host.querySelector('.launch-backdrop')).toBeNull();
    expect(host.querySelector('.launch-dialog')).toBeNull();
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Close')).toBe(false);

    const backButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '‹ Back to workspace')!;
    expect(backButton).not.toBeUndefined();
    await act(async () => { backButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(backCount).toBe(1);
  });

  it('switches between General, Profiles, and Collaborators tabs, hiding the inactive panels', async () => {
    vi.stubGlobal('fetch', baseFetchMock());
    const host = await mount();

    const general = host.querySelector('#settings-tabpanel-general') as HTMLElement;
    const profiles = host.querySelector('#settings-tabpanel-profiles') as HTMLElement;
    const collaborators = host.querySelector('#settings-tabpanel-collaborators') as HTMLElement;
    expect(general.hidden).toBe(false);
    expect(profiles.hidden).toBe(true);
    expect(collaborators.hidden).toBe(true);

    await act(async () => { tabButton(host, 'Profiles').click(); });
    expect(general.hidden).toBe(true);
    expect(profiles.hidden).toBe(false);
    expect(collaborators.hidden).toBe(true);

    await act(async () => { tabButton(host, 'Collaborators').click(); });
    expect(general.hidden).toBe(true);
    expect(profiles.hidden).toBe(true);
    expect(collaborators.hidden).toBe(false);
  });

  it('preserves an unsaved API key draft on General across a tab switch', async () => {
    vi.stubGlobal('fetch', baseFetchMock());
    const host = await mount();

    const keyInput = host.querySelector('.settings-key-row input') as HTMLInputElement;
    await act(async () => { setInputValue(keyInput, 'sk-draft-value'); });
    expect(keyInput.value).toBe('sk-draft-value');

    await act(async () => { tabButton(host, 'Collaborators').click(); });
    await act(async () => { tabButton(host, 'General').click(); });

    const keyInputAfter = host.querySelector('.settings-key-row input') as HTMLInputElement;
    expect(keyInputAfter.value).toBe('sk-draft-value');
  });

  it('A14: preserves an unsubmitted new-Profile draft on Profiles across a tab switch, even while the "New profile" form is collapsed', async () => {
    vi.stubGlobal('fetch', baseFetchMock());
    const host = await mount();

    await act(async () => { tabButton(host, 'Profiles').click(); });
    await act(async () => { openNewProfileForm(host); });
    const nameInput = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Draft profile name'); });
    expect(nameInput.value).toBe('Draft profile name');

    // collapse the "New profile" form (still on the Profiles tab) — the draft must not be lost
    await act(async () => { openNewProfileForm(host); });
    expect(nameInput.closest('[hidden]')).not.toBeNull();

    await act(async () => { tabButton(host, 'General').click(); });
    await act(async () => { tabButton(host, 'Profiles').click(); });

    const nameInputAfter = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    expect(nameInputAfter.closest('[hidden]')).not.toBeNull(); // still collapsed, not reopened by the tab switch
    expect(nameInputAfter.value).toBe('Draft profile name');
  });

  it('preserves a freshly issued one-time invitation code across a tab switch', async () => {
    const fetchMock = baseFetchMock((url, init) => {
      if (url === '/api/collaborators' && init?.method === 'POST') {
        return jsonResponse({
          collaborator: { id: 'c1', displayName: 'Bob', createdAt: '2026-01-01T00:00:00.000Z', grantedRepositoryIds: [], grantedProfileIds: [] },
          invitation: { id: 'inv-1', collaboratorId: 'c1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
          code: 'brand-new-one-time-code',
        }, 201);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = await mount();

    await act(async () => { tabButton(host, 'Collaborators').click(); });
    const nameInput = host.querySelector('input[aria-label="Collaborator name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Bob'); });
    const createButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Create invitation')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain('brand-new-one-time-code');

    await act(async () => { tabButton(host, 'Profiles').click(); });
    await act(async () => { tabButton(host, 'Collaborators').click(); });

    expect(host.textContent).toContain('brand-new-one-time-code');
  });

  it('ticket 12 AC1: a Profile created in the Profiles tab is immediately offered as a grant checkbox in the Collaborators tab', async () => {
    const fetchMock = baseFetchMock((url, init) => {
      if (url === '/api/profiles' && init?.method === 'POST') {
        return jsonResponse({
          id: 'profile-1', name: 'Standard Codex run', runtimePreference: ['codex'],
          budget: { maxWallClockMs: 3_600_000 }, verificationIntent: { required: false, commands: [] },
          requestedDeliveryResult: 'local-commit', createdAt: '2026-01-01T00:00:00.000Z',
        }, 201);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = await mount();

    await act(async () => { tabButton(host, 'Profiles').click(); });
    await act(async () => { openNewProfileForm(host); });
    const nameInput = host.querySelector('input[aria-label="Profile name"]') as HTMLInputElement;
    await act(async () => { setInputValue(nameInput, 'Standard Codex run'); });
    const createButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Create Profile')!;
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await act(async () => { tabButton(host, 'Collaborators').click(); });
    expect(host.querySelectorAll('.collaborators-profile-grants input[type="checkbox"]')).toHaveLength(1);
    expect(host.textContent).toContain('Standard Codex run');
  });

  it('shows an error when GET /api/settings fails, without blocking the other tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/settings') throw new Error('network down');
      if (url === '/api/models') return jsonResponse([]);
      return jsonResponse([]);
    }));
    const host = await mount();

    expect(host.textContent).toContain('Unable to load settings.');

    await act(async () => { tabButton(host, 'Profiles').click(); });
    expect(host.textContent).toContain('No Profiles yet.');
  });

  it('renders the appearance control passed in on the General tab', async () => {
    vi.stubGlobal('fetch', baseFetchMock());
    await act(async () => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(<SettingsWorkspace appearanceControl={<button type="button">Appearance control</button>} onBack={() => {}} repos={[]} />);
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('Appearance control');
  });
});

for (const [label, body, status] of [['denied', { error: 'Forbidden' }, 403], ['malformed', { models: [] }, 200]] as const) {
  it(`reports ${label} model responses without rendering an object as a list`, async () => {
    vi.stubGlobal('fetch', baseFetchMock((url) => url === '/api/models' ? jsonResponse(body, status) : undefined));
    const host = await mount();
    expect(host.textContent).toContain('Unable to load settings.');
    expect(host.textContent).toContain('Profiles');
  });
}
