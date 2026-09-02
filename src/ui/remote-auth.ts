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
