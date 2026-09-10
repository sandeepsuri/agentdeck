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
  CollaboratorSession, CollaboratorSessionCapabilities, CollaboratorSessionMessage, SessionChatMessage,
  SessionInteraction, SessionInteractionsView,
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
 * Whether an @agent message can reach this Session. Uses the same capability
 * check for admins and collaborators; ordinary chat remains available.
 */
export function getSessionCapabilities(
  sessionId: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<CollaboratorSessionCapabilities> {
  return fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities?mode=chat`)
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

/**
 * The shared session chat (docs/specs/shared-session-chat.md): every
 * participant's posts, attributed to who actually sent them, merged with the
 * agent's own turns. Supersedes listSessionMessages for the chat surface --
 * that route still exists and still collapses every human into "human", but
 * nothing here calls it any more.
 */
export function listChatMessages(
  sessionId: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<SessionChatMessage[]> {
  return fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/chat`)
    .then((response) => responseJsonArray<SessionChatMessage>(response));
}

/**
 * Posts one message to a granted Session's shared chat. The server alone
 * decides whether it was addressed to the agent (an explicit @agent mention)
 * and, if so, whether delivery succeeded -- the returned message carries
 * that outcome (`audience`/`delivery`/`deliveryReason`) exactly as recorded,
 * so the caller never has to guess it from the request it sent.
 */
export async function postChatMessage(
  sessionId: string,
  text: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<SessionChatMessage> {
  const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({})) as Partial<SessionChatMessage> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Unable to send this message.');
  return body as SessionChatMessage;
}

export function getSessionInteractions(
  sessionId: string,
  fetcher: SessionFetcher = apiFetch,
): Promise<SessionInteractionsView> {
  return fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/interactions`)
    .then((response) => responseJson<SessionInteractionsView>(response));
}

export async function respondToSessionInteraction(
  sessionId: string,
  requestId: string,
  response: { answers: Record<string, string[]>; freeText?: boolean } | { decision: 'approve' | 'deny' },
  fetcher: SessionFetcher = apiFetch,
): Promise<SessionInteraction> {
  const result = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(response),
  });
  const body = await result.json().catch(() => ({})) as Partial<SessionInteraction> & { error?: string };
  if (!result.ok) throw new Error(body.error ?? 'Unable to answer this request.');
  return body as SessionInteraction;
}
