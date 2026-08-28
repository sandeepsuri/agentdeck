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

export async function fetchConnection(): Promise<{ kind: 'local' | 'remote' | 'denied'; capabilities: string[] }> {
  const response = await apiFetch('/api/connection');
  return response.json() as Promise<{ kind: 'local' | 'remote' | 'denied'; capabilities: string[] }>;
}
