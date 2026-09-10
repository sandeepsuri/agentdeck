// SessionConversation (docs/specs/shared-session-chat.md): the module that
// decides who a chat post came from and merges it with the agent's own
// output into one attributed, chronological feed. POST and GET
// /api/sessions/:id/chat (routes.ts) both go through this rather than
// duplicating either decision.
//
// Shared by the admin Dashboard and collaborator Session chat. Raw terminal
// access remains a separate operator surface.
import { resolveLocalPrincipal } from '../work-engine/principal.js';
import type { StoredSessionChatMessage } from '../store/index.js';
import type { AgentMessage, Session, SessionChatMessage } from '../types.js';
import { relativizePaths } from './collaborator-run-view.js';
import { sessionRoots } from './collaborator-session-view.js';
import type { TrustResult } from './connection-trust.js';

/**
 * Who posted a chat message, derived the same way the route enforces it --
 * never trusted from the request body. A resolved collaborator device names
 * its own Principal; a local request resolves through the same local-user
 * mechanism a Run's own Principal already uses (work-engine/principal.ts),
 * so "who sent this" agrees everywhere AgentDeck records a Principal. Only
 * the legacy shared tailnet token -- authenticated, but not a named
 * individual -- falls back to a label instead of an identity.
 */
export function resolveSenderIdentity(trust: TrustResult): { principalId?: string; displayName: string } {
  if (trust.device) {
    return { principalId: trust.device.principal.id, displayName: trust.device.principal.displayName };
  }
  if (trust.kind === 'local') {
    const principal = resolveLocalPrincipal();
    return { principalId: principal.id, displayName: principal.displayName };
  }
  return { displayName: 'Shared access' };
}

/** This Session's runtime, as a chat display name. */
function agentDisplayName(session: Session): string {
  return session.agent === 'claude' ? 'Claude Code' : 'Codex';
}

/**
 * The agent's own turns from the bus tail. Deliberately never a `dashboard:`
 * row -- that prefix marks a HUMAN send (collaborator-session-view.ts's own
 * reasoning), now recorded with real attribution in session_chat_messages
 * instead, so including it here would show a human's message twice, once
 * under their own name and once mislabeled as the agent.
 */
function agentTurns(
  session: Session,
  messages: readonly AgentMessage[],
): { ts: string; text: string; event: 'message' | 'done' }[] {
  const roots = sessionRoots(session);
  return messages.flatMap((message) => {
    if (message.agent.startsWith('dashboard:')) return [];
    const belongsToSession = message.sessionId === session.id
      || (session.agentSessionId !== undefined && message.agent === session.agentSessionId);
    if (!belongsToSession || (message.event !== 'done' && message.event !== 'message')) return [];
    const text = message.message ?? message.summary;
    if (typeof text !== 'string' || text.trim().length === 0) return [];
    return [{ ts: message.ts, text: relativizePaths(text, roots), event: message.event }];
  });
}

function humanToWire(row: StoredSessionChatMessage): SessionChatMessage {
  const wire: SessionChatMessage = {
    id: row.id, ts: row.ts, authorKind: 'human', displayName: row.displayName, text: row.text, audience: row.audience,
  };
  if (row.principalId !== undefined) wire.principalId = row.principalId;
  if (row.delivery !== undefined) wire.delivery = row.delivery;
  if (row.deliveryReason !== undefined) wire.deliveryReason = row.deliveryReason;
  return wire;
}

const MAX_MERGED_MESSAGES = 100;

/**
 * The whole shared conversation for one Session: every durably posted human
 * message plus the agent's own bus turns, as one chronological, attributed
 * feed -- never a raw bus row, and never a human message collapsed into
 * "human"/"You" the way CollaboratorSessionMessage did.
 */
export function mergeConversation(
  session: Session,
  humanMessages: readonly StoredSessionChatMessage[],
  busMessages: readonly AgentMessage[],
): SessionChatMessage[] {
  const displayName = agentDisplayName(session);
  const agent: SessionChatMessage[] = agentTurns(session, busMessages).map((turn) => ({
    id: `agent:${turn.ts}`, ts: turn.ts, authorKind: 'agent', displayName, text: turn.text, event: turn.event,
  }));
  const human = humanMessages.map(humanToWire);
  return [...human, ...agent].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-MAX_MERGED_MESSAGES);
}
