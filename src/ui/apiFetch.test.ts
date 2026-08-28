import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_HEADER } from '../protocol.js';
import { apiFetch, fetchConnection } from './apiFetch.js';

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

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls fetch with no auth header when no token is stored', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/sessions');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions');
    expect(init?.headers).toEqual({});
  });

  it('attaches the stored token header', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'agentdeck.connection.token': 'my-token' }));
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/sessions');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ [TOKEN_HEADER]: 'my-token' });
  });

  it('validates /api/connection with the stored token on reload and token submission', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'agentdeck.connection.token': 'saved-phone-token' }));
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({
      kind: 'remote', capabilities: ['view', 'compose', 'control-keys'],
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConnection()).resolves.toEqual({
      kind: 'remote', capabilities: ['view', 'compose', 'control-keys'],
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/connection', {
      headers: { [TOKEN_HEADER]: 'saved-phone-token' },
    });
  });

  it('merges caller-supplied init, with caller headers taking precedence', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'agentdeck.connection.token': 'my-token' }));
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: 'override' },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      [TOKEN_HEADER]: 'override',
    });
  });
});
