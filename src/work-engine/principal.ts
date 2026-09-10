// Ticket 10 AC2: resolves the Principal (CONTEXT.md) recorded against every
// Run submitted from this process. AgentDeck has no multi-user
// authentication yet — that is tickets 11/12's job (named collaborator
// device credentials, authorized launches) — so today every Run's Principal
// is simply the local OS user running AgentDeck, never a Session or
// transport identifier (CONTEXT.md's Principal entry explicitly says to
// avoid conflating the two).
import os from 'node:os';
import type { RunPrincipal } from './types.js';

export function resolveLocalPrincipal(): RunPrincipal {
  const { username } = os.userInfo();
  return { id: `local:${username}`, displayName: username };
}
