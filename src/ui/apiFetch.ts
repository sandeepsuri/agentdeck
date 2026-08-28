// Ticket 05: every /api/* call from the UI must carry the tailnet token
// when one is stored, or nothing works past the initial page load once a
// phone is remote-but-authenticated. Call sites across src/ui/** that hit
// /api/* use this instead of the bare `fetch` (see App.tsx and friends);
// GET /api/connection also goes through this wrapper: the route is exempt
// from the authentication gate so a missing token can discover the prompt,
// but a stored token must be sent so reloads can validate it immediately.
import { authHeaders } from './connection.js';

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
}

/** Reject HTTP errors before a caller can mistake an error payload for domain data. */
export async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

/** Collection endpoints must return an array, never an `{ error }` payload. */
export async function responseJsonArray<T>(response: Response): Promise<T[]> {
  const body = await responseJson<unknown>(response);
  if (!Array.isArray(body)) throw new Error('expected an array response');
  return body as T[];
}

export async function fetchConnection(): Promise<{ kind: 'local' | 'remote' | 'denied'; capabilities: string[] }> {
  const response = await apiFetch('/api/connection');
  return responseJson(response);
}
