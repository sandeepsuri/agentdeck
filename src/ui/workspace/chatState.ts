// Redesign spec §09: the shared chat composer makes its recipient explicit,
// and a message delivered to an agent is followed by a visible working state.
// The @agent mention stays the one routing signal the server enforces
// (../../mentions.js) — the recipient control only reads and writes it.
import { parseMention } from '../../mentions.js';
import type { SessionChatMessage, SessionProcessingState } from '../../types.js';

export type ChatRecipient = 'team' | 'agent';

export function recipientForDraft(text: string): ChatRecipient {
  return parseMention(text).mentioned ? 'agent' : 'team';
}

export function draftForRecipient(text: string, recipient: ChatRecipient): string {
  if (recipient === 'agent') {
    if (parseMention(text).mentioned) return text;
    return text.trim() ? `@agent ${text.trimStart()}` : '@agent ';
  }
  const parsed = parseMention(text);
  return parsed.mentioned ? parsed.agentPayload ?? '' : text;
}

/** States in which the agent has stopped working: it is blocked on a human, failed, or gone. */
const SETTLED: ReadonlySet<SessionProcessingState> = new Set(['waiting_answer', 'waiting_approval', 'failed', 'disconnected', 'finished']);

export function isAgentWorking({ processingState, awaitingSince, agentStarted = false, messages }: {
  processingState: SessionProcessingState | undefined;
  /** When this composer last delivered a message to the agent, or null. */
  awaitingSince: string | null;
  /** True once the server reported the agent working after that delivery — a later idle then means the turn ended without a chat reply. */
  agentStarted?: boolean;
  messages: readonly SessionChatMessage[];
}): boolean {
  if (processingState && SETTLED.has(processingState)) return false;
  if (agentStarted && processingState === 'idle') return false;
  if (awaitingSince && !messages.some((message) => message.authorKind === 'agent' && message.ts > awaitingSince)) return true;
  return processingState === 'working';
}
