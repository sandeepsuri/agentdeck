import { describe, expect, it } from 'vitest';
import { TOKEN_HEADER } from '../protocol.js';
import { authHeaders, getStoredToken, setStoredToken, TOKEN_STORAGE_KEY } from './connection.js';

function storageWith(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => key === TOKEN_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => { if (key === TOKEN_STORAGE_KEY) value = next; },
    removeItem: (key: string) => { if (key === TOKEN_STORAGE_KEY) value = null; },
    value: () => value,
  };
}

describe('getStoredToken / setStoredToken', () => {
  it('reads nothing by default and round-trips a stored token', () => {
    const storage = storageWith();
    expect(getStoredToken(storage)).toBeUndefined();
    setStoredToken(storage, 'my-token');
    expect(storage.value()).toBe('my-token');
    expect(getStoredToken(storage)).toBe('my-token');
  });

  it('treats undefined storage as no token, without throwing', () => {
    expect(getStoredToken(undefined)).toBeUndefined();
    expect(() => setStoredToken(undefined, 'x')).not.toThrow();
  });

  it('falls back safely when storage access throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(getStoredToken(broken)).toBeUndefined();
    expect(() => setStoredToken(broken, 'x')).not.toThrow();
  });

  it('treats an empty stored value as no token', () => {
    expect(getStoredToken(storageWith(''))).toBeUndefined();
  });
});

describe('authHeaders', () => {
  it('returns an empty object when no token is stored', () => {
    expect(authHeaders(storageWith())).toEqual({});
  });

  it('returns the token header when a token is stored', () => {
    expect(authHeaders(storageWith('my-token'))).toEqual({ [TOKEN_HEADER]: 'my-token' });
  });
});
