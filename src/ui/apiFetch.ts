// Ticket 05: every /api/* call from the UI must carry the tailnet token
// when one is stored, or nothing works past the initial page load once a
// phone is remote-but-authenticated. Call sites across src/ui/** that hit
// /api/* use this instead of the bare `fetch` (see App.tsx and friends);
// GET /api/connection is the one deliberate exception (see App.tsx) since
// that route ignores the token by design.
import { authHeaders } from './connection.js';

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
}
