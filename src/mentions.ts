// Shared mention parsing (docs/specs/shared-session-chat.md's "Mention
// semantics"). Both the chat composer (client, for its send-destination
// preview) and POST /api/sessions/:id/chat (server, for enforcement) import
// this — never two implementations that could disagree about what counts as
// "addressed to the agent". Pure and side-effect free, like protocol.ts.
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const MENTION = /@agent\b/gi;

/** Character ranges (start, end) of fenced/inline code, so a mention inside either is never routed to the agent. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const pattern of [FENCED_CODE, INLINE_CODE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

function insideAny(index: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

export interface MentionParse {
  /** True when an explicit, unescaped, standalone @agent mention addresses this message to the agent. */
  mentioned: boolean;
  /**
   * The text to actually forward to the agent -- the mention token(s)
   * removed and surrounding whitespace collapsed. Present only when
   * `mentioned` is true. The message as posted to the shared conversation is
   * never altered; this is only the delivery payload (server/
   * session-conversation.ts strips it out of the stored, displayed text).
   */
  agentPayload?: string;
}

/**
 * A case-insensitive standalone `@agent`, anywhere in ordinary prose,
 * including trailing punctuation ("@agent, please review"). Not "@agents"
 * (word boundary after "agent" excludes it), not an email-like "foo@agent"
 * (a word character immediately before "@" excludes it), not an escaped
 * "\@agent", and never one found inside fenced or inline code. Multiple
 * mentions in one message still produce a single delivery.
 */
export function parseMention(text: string): MentionParse {
  const ranges = codeRanges(text);
  const matches: [number, number][] = [];
  MENTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (insideAny(start, ranges)) continue;
    const before = text[start - 1];
    if (before !== undefined && (/[\w.]/.test(before) || before === '\\')) continue;
    matches.push([start, end]);
  }
  if (matches.length === 0) return { mentioned: false };

  let payload = '';
  let cursor = 0;
  for (const [start, end] of matches) {
    payload += text.slice(cursor, start);
    cursor = end;
  }
  payload += text.slice(cursor);
  // Removing "@agent" from "@agent, please review" leaves ", please
  // review" -- trim a leading run of punctuation/space so the payload reads
  // as a request, and collapse the double space a mid-sentence removal
  // leaves behind. Never touches text the author actually wrote otherwise.
  payload = payload.replace(/^[\s,:;.!-]+/, '').replace(/\s+/g, ' ').trim();
  return { mentioned: true, agentPayload: payload };
}
