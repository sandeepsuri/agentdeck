// Ticket 05: the client half of ConnectionTrust. Holds the tailnet access
// token in localStorage (entered once on the phone, per the spec) and
// builds the header every /api/* call needs to carry it. See
// src/server/connection-trust.ts for the server-side classification this
// feeds, and apiFetch.ts for the fetch wrapper that attaches these headers.
import { TOKEN_HEADER } from '../protocol.js';

export const TOKEN_STORAGE_KEY = 'agentdeck.connection.token';

interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Same injectable-storage shape as preferences.ts's
 * inspectorPreferenceStorage — wraps localStorage, absent (not throwing)
 * outside a browser. `globalThis.localStorage` rather than
 * `window.localStorage` so this also works under vitest's node environment
 * with `vi.stubGlobal('localStorage', ...)` (see apiFetch.test.ts); in an
 * actual browser tab `globalThis` is `window`.
 */
export function tokenStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function getStoredToken(storage: TokenStorage | undefined): string | undefined {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(TOKEN_STORAGE_KEY);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setStoredToken(storage: TokenStorage | undefined, token: string): void {
  if (!storage) return;
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Persistence is optional; the current page can still use the token.
  }
}

/** Headers to merge into every /api/* request: the token header when one is stored, nothing otherwise (the ordinary loopback/desktop case). */
export function authHeaders(storage: TokenStorage | undefined = tokenStorage()): HeadersInit {
  const token = getStoredToken(storage);
  return token ? { [TOKEN_HEADER]: token } : {};
}
