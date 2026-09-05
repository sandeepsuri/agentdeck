// The Collaborator workspace's Session API surface — the sibling of
// collaboratorRuns.ts, same house pattern: components import these, never
// apiFetch directly.
//
// Every read here is grant-filtered AND narrowed server-side (see
// server/collaborator-session-view.ts), so nothing in this module needs to
// know what a Collaborator may see. It only knows the shapes.
//
// There is no WebSocket half. A collaborator socket is refused 'attach' and
// both session broadcasts (ws.ts), because those carry raw PTY bytes and a
// machine-wide view of every Session. What a Collaborator gets instead is the
// conversation — the same message list the admin's chat view reads — polled
// exactly the way CollaboratorWorkspace already polls an open Run.
import { apiFetch, responseJson, responseJsonArray } from './apiFetch.js';
import type {
  CollaboratorSession, CollaboratorSessionCapabilities, CollaboratorSessionMessage,
} from '../types.js';

type SessionFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export function listCollaboratorSessions(fetcher: SessionFetcher = apiFetch): Promise<CollaboratorSession[]> {
  return fetcher('/api/sessions').then((response) => responseJsonArray<CollaboratorSession>(response));
}

export function listSessionMessages(
  sessionId: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<CollaboratorSessionMessage[]> {
  return fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
    .then((response) => responseJsonArray<CollaboratorSessionMessage>(response));
}

/**
 * Whether this Session's composer can be offered at all. The server answers
 * from the same pure function its send route checks, so the composer is never
 * shown for a Session that would then refuse the message.
 */
export function getSessionCapabilities(
  sessionId: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<CollaboratorSessionCapabilities> {
  return fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities`)
    .then((response) => responseJson<CollaboratorSessionCapabilities>(response));
}

/**
 * Send one message to a granted Session. 'typed' means it went straight to a
 * managed agent's input; 'queued' means it was left in the hook inbox for an
 * external agent to pick up on its next turn — a real distinction to a reader
 * waiting for a reply, so the caller is told which happened.
 */
export async function sendSessionMessage(
  sessionId: string,
  text: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<{ delivered: 'typed' | 'queued' }> {
  const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({})) as { delivered?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Unable to send to this agent.');
  return { delivered: body.delivered === 'typed' ? 'typed' : 'queued' };
}
