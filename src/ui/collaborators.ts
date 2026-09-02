// Ticket 11: client side of named collaborator device credentials.
// Admin actions (invite/list/grant/revoke) go through the desktop-only
// CollaboratorsPanel; exchangeInvitationCode is the one collaborator-facing
// action, reachable from a not-yet-authenticated remote connection's
// connection gate (App.tsx) — see collaborator-routes.ts's
// REMOTE_PRE_AUTH_ROUTES exemption on the server side.
import { apiFetch, responseJson } from './apiFetch.js';
import { setStoredToken, tokenStorage } from './connection.js';

export interface DeviceCredential {
  id: string;
  collaboratorId: string;
  deviceLabel: string;
  createdAt: string;
  revokedAt?: string;
}

export interface Collaborator {
  id: string;
  displayName: string;
  createdAt: string;
  grantedRepositoryIds: string[];
  devices: DeviceCredential[];
}

export async function listCollaborators(): Promise<Collaborator[]> {
  return responseJson(await apiFetch('/api/collaborators'));
}

export async function inviteCollaborator(
  input: { displayName: string; grantedRepositoryIds: string[] },
): Promise<{ collaborator: Collaborator; code: string }> {
  const response = await apiFetch('/api/collaborators', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return responseJson(response);
}

export async function inviteExistingCollaborator(collaboratorId: string): Promise<{ code: string }> {
  const response = await apiFetch(`/api/collaborators/${collaboratorId}/invitations`, { method: 'POST' });
  return responseJson(response);
}

export async function updateGrants(collaboratorId: string, grantedRepositoryIds: string[]): Promise<Collaborator> {
  const response = await apiFetch(`/api/collaborators/${collaboratorId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grantedRepositoryIds }),
  });
  return responseJson(response);
}

export async function revokeDevice(deviceId: string): Promise<DeviceCredential> {
  const response = await apiFetch(`/api/collaborators/devices/${deviceId}/revoke`, { method: 'POST' });
  return responseJson(response);
}

/** The authenticated collaborator identity a device credential resolves to (CONTEXT.md's Principal). */
export interface CollaboratorPrincipal {
  id: string;
  displayName: string;
}

export type ExchangeResult =
  | { ok: true; principal: CollaboratorPrincipal }
  | { ok: false; error: string };

/**
 * AC1: exchanges a one-time invitation code for a durable device credential.
 * The returned bearer token is stored exactly like the shared tailnet token
 * (connection.ts's setStoredToken) so every subsequent /api/* call
 * authenticates automatically — the caller only needs to re-check
 * GET /api/connection afterward (see App.tsx's connection gate), not thread
 * the token through itself.
 */
export async function exchangeInvitationCode(
  code: string,
  deviceLabel: string,
  storage: Storage | undefined = tokenStorage(),
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await apiFetch('/api/collaborators/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel }),
    });
  } catch {
    return { ok: false, error: 'Could not reach AgentDeck to check the invitation code.' };
  }
  const body = await response.json() as { token?: string; principal?: CollaboratorPrincipal; error?: string };
  if (!response.ok || !body.token || !body.principal) {
    return { ok: false, error: body.error ?? 'That invitation code was not accepted.' };
  }
  setStoredToken(storage, body.token);
  return { ok: true, principal: body.principal };
}
