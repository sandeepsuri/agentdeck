import type { Session } from '../types.js';

/**
 * launchSpec is retained server-side so managed sessions can be restarted.
 * It can contain prompts, environment secrets, and command-line arguments,
 * none of which belong in REST responses or WebSocket broadcasts.
 */
export function publicSession(session: Session): Session {
  const { launchSpec: _privateLaunchSpec, ...publicFields } = session;
  return publicFields;
}
