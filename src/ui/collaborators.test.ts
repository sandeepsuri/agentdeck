import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeInvitationCode } from './collaborators.js';
import { TOKEN_STORAGE_KEY } from './connection.js';

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function fakeStorage(initial: Record<string, string> = {}): Storage {
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

describe('exchangeInvitationCode (ticket 11 AC1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stores the returned device token and reports the resolved Principal on success', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({
      token: 'brand-new-device-token', device: { id: 'device-1' }, principal: { id: 'collab-1', displayName: 'Alice' },
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage();

    const result = await exchangeInvitationCode('a-code', "Alice's phone", storage);

    expect(result).toEqual({ ok: true, principal: { id: 'collab-1', displayName: 'Alice' } });
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe('brand-new-device-token');
  });

  it('sends the code and device label as the request body, with no auth header yet (no token stored)', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({
      token: 't', principal: { id: 'c', displayName: 'Bob' },
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeInvitationCode('a-code', 'device', fakeStorage());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/collaborators/exchange');
    expect(JSON.parse(init!.body as string)).toEqual({ code: 'a-code', deviceLabel: 'device' });
    expect(init!.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('reports the server error and never stores anything for a rejected code', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({
      error: 'No such invitation code.',
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage();

    const result = await exchangeInvitationCode('bogus', 'device', storage);

    expect(result).toEqual({ ok: false, error: 'No such invitation code.' });
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('reports a generic error when fetch itself rejects (offline/unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await exchangeInvitationCode('a-code', 'device', fakeStorage());
    expect(result).toEqual({ ok: false, error: 'Could not reach AgentDeck to check the invitation code.' });
  });

  it('never authenticates with only a token and no principal in the response', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify({
      token: 'x',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage();

    const result = await exchangeInvitationCode('a-code', 'device', storage);

    expect(result.ok).toBe(false);
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
