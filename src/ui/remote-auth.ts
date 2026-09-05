// Ticket 12: apiFetch.ts's ConnectionInfo is a superset (adds an optional
// `principal` for a resolved collaborator device) of what this module ever
// reads. Imported (not redefined) and re-exported so existing importers of
// `./remote-auth.js`'s ConnectionInfo keep working unchanged.
import type { ConnectionInfo } from './apiFetch.js';
export type { ConnectionInfo };

/**
 * Finishes a successful first-time phone authentication before the mobile
 * gate opens. The pre-auth session request may have failed with 403, so its
 * stale error and empty list must not survive the accepted token.
 */
export async function finalizeRemoteAuthentication(
  connection: ConnectionInfo,
  refreshSessions: () => Promise<unknown>,
  clearError: () => void,
): Promise<boolean> {
  if (connection.kind !== 'remote' || connection.capabilities.length === 0) return false;
  clearError();
  await refreshSessions();
  return true;
}

/** Which workspace tree a connection resolves to, and whether the gate is still in the way. */
export interface ConnectionState {
  kind: 'local' | 'remote';
  gate: 'ready' | 'needs-token' | 'denied';
  /** The named collaborator this device's credential resolved to, or null for local and for the legacy shared tailnet token. */
  principal: { id: string; displayName: string } | null;
}

/**
 * The one reading of GET /api/connection.
 *
 * App learns its identity in three places — the initial probe, the token
 * form, and the invitation-code form — and they used to reach three separate
 * sets of setState calls. Two of them dropped `principal`, so a collaborator
 * who had just redeemed an invitation code was rendered the admin's session
 * view (MobileWorkspace forks on it) until a full page reload. Pure and
 * shared, so the three cannot disagree, and so the disagreement that did
 * happen is a test rather than a thing to notice on a phone.
 */
export function resolveConnectionState(connection: ConnectionInfo): ConnectionState {
  const kind = connection.kind === 'remote' ? 'remote' as const : 'local' as const;
  const gate = connection.kind === 'denied'
    ? 'denied' as const
    : connection.kind === 'remote' && connection.capabilities.length === 0
      ? 'needs-token' as const
      : 'ready' as const;
  return { kind, gate, principal: connection.principal ?? null };
}
