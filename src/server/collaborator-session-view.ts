// The Collaborator-safe projection of a Session and its conversation.
//
// GET /api/sessions, /api/sessions/:id/messages and /api/sessions/:id/
// capabilities are the SAME routes the local admin uses, and a Session is an
// admin's-eye record: cwd and worktreePath are absolute locations on the
// operator's machine, tty/terminalApp/tmuxTarget/backend/pid describe how
// that machine is laid out, launchSpec can carry an initial prompt and
// environment secrets, and agentSessionId is the agent CLI's own handle.
// None of that is inside a Repository grant -- a grant says "you may see this
// Repository's work," not "you may see how this machine is wired."
//
// So this module narrows a Session that has ALREADY been authorized for
// reading. Like collaborator-run-view.ts it deliberately does not filter by
// grants (routes.ts owns that, against `repoId`) and deliberately does not
// decide authorization. security.ts's publicSession is the same boundary one
// layer in -- it strips only launchSpec, because a local or shared-token
// remote connection is entitled to the rest; a collaborator device is not.
//
// The conversation, not the bus: a Collaborator gets the message text the
// admin's own chat view shows, never the raw AgentMessage row, whose `repo`
// is an absolute path and whose `agent` embeds the agent CLI's session id.
// relativizePaths is defense in depth on top of those field-level drops, for
// free text that legitimately still crosses out and can name a path the agent
// typed itself -- the same reasoning, and the same helper, as a Run's
// narrative.
import type {
  AgentMessage, CollaboratorSession, CollaboratorSessionCapabilities, CollaboratorSessionMessage, Session,
} from '../types.js';
import { relativizePaths } from './collaborator-run-view.js';

export type { CollaboratorSession, CollaboratorSessionCapabilities, CollaboratorSessionMessage } from '../types.js';

/** How many turns a conversation response carries. Matches the admin route's own tail, so neither view silently sees more history than the other. */
const MAX_MESSAGES = 100;

/**
 * This Session's own absolute roots, longest-first handling left to
 * relativizePaths. `repoId` is a Repository id, which in this codebase IS the
 * Repository's absolute path (git/scan.ts) -- it is listed here as a root to
 * rewrite out of free text, not as something being newly disclosed: a
 * collaborator already holds it, because GET /api/repos returns it as
 * `repo.id` and every grant is stored against it.
 */
function sessionRoots(session: Session): readonly string[] {
  return [session.worktreePath, session.repoId, session.cwd].filter((value): value is string => Boolean(value));
}

/**
 * Narrows one Session. `repoId` is required in the result because a Session
 * without one cannot be grant-scoped at all, so routes.ts drops those before
 * reaching here rather than passing an unscopable Session through.
 */
export function collaboratorSession(session: Session & { repoId: string }): CollaboratorSession {
  return {
    id: session.id,
    origin: session.origin,
    agent: session.agent,
    ...(session.name ? { name: session.name } : {}),
    repoId: session.repoId,
    ...(session.branch ? { branch: session.branch } : {}),
    status: session.status,
    statusSource: session.statusSource,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
  };
}

/**
 * Narrows the bus rows GET /api/sessions/:id/messages already selected for
 * one Session. A row whose author prefix is `dashboard:` was sent through
 * AgentDeck's own composer (by the admin or by a collaborator), so it reads
 * as the human side of the conversation; everything else is the agent. Rows
 * with no usable text are dropped rather than rendered blank.
 */
export function collaboratorMessages(
  messages: readonly AgentMessage[],
  roots: readonly string[],
): CollaboratorSessionMessage[] {
  return messages.flatMap((message) => {
    const text = message.message ?? message.summary;
    if (typeof text !== 'string' || text.trim().length === 0) return [];
    if (message.event !== 'message' && message.event !== 'done') return [];
    return [{
      ts: message.ts,
      author: message.agent.startsWith('dashboard:') ? 'human' as const : 'agent' as const,
      event: message.event,
      text: relativizePaths(text, roots),
    }];
  }).slice(-MAX_MESSAGES);
}

/** Convenience for the route: narrow a Session's conversation using that Session's own roots. */
export function collaboratorSessionMessages(
  session: Session,
  messages: readonly AgentMessage[],
): CollaboratorSessionMessage[] {
  return collaboratorMessages(messages, sessionRoots(session));
}

/**
 * What a Collaborator's composer may do with this Session, and why not when
 * the answer is nothing. Deliberately narrower than the admin's own
 * GET /api/sessions/:id/capabilities: that route can answer 'terminal' or
 * 'vscode', meaning "AgentDeck will script the operator's terminal app for
 * you", and a collaborator never reaches that path (see POST /send). Pure
 * over the Session so the send route and the capabilities route cannot
 * disagree about whether a composer should have been offered.
 */
export function collaboratorSendCapability(session: Session): CollaboratorSessionCapabilities {
  if (session.status === 'exited') {
    return { send: 'unavailable', reason: 'This agent has finished. Its conversation is read-only.' };
  }
  if (session.origin === 'managed') return { send: 'managed' };
  if (session.agent !== 'claude') {
    return { send: 'unavailable', reason: 'This agent runs in a terminal that cannot receive messages.' };
  }
  if (!session.agentSessionId) {
    return {
      send: 'unavailable',
      reason: 'This agent has not finished connecting to AgentDeck yet. Try again once it has run a turn.',
    };
  }
  return { send: 'queued' };
}
