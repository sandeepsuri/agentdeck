// Conversation: the session's exchange with its agent as a chat — your
// messages on the right, the agent's replies on the left, its tool calls
// folded into one line per stretch of work. Read from the agent's own
// transcript (GET /api/sessions/:id/conversation), so it is exactly what the
// agent saw and said, with none of the TUI's redraw noise. The composer types
// into the live session through the same /send path as the terminal
// composer; approvals and menus still happen in the Terminal tab.
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationTurn, ConversationView as ConversationBody } from '../../sessions/conversation.js';
import type { Session } from '../../types.js';
import { apiFetch } from '../apiFetch.js';
import { Markdown } from './markdown.js';

const POLL_MS = 1500;
/** Within this many pixels of the end counts as "following along". */
const STICKY_PX = 80;

export type ConversationItem =
  | { kind: 'message'; turn: ConversationTurn }
  | { kind: 'tools'; id: string; turns: ConversationTurn[] };

/** Consecutive tool calls become one collapsible group. */
export function groupTurns(turns: readonly ConversationTurn[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const turn of turns) {
    const last = items.at(-1);
    if (turn.role !== 'tool') items.push({ kind: 'message', turn });
    else if (last?.kind === 'tools') last.turns.push(turn);
    else items.push({ kind: 'tools', id: turn.id, turns: [turn] });
  }
  return items;
}

function ToolGroup({ turns }: { turns: ConversationTurn[] }) {
  const names = [...new Set(turns.map((turn) => turn.toolName ?? 'tool'))].slice(0, 3).join(', ');
  return (
    <details className="conversation-tools">
      <summary>{turns.length === 1 ? `Used ${names}` : `Ran ${turns.length} steps · ${names}`}</summary>
      <ol>
        {turns.map((turn) => <li key={turn.id}><strong>{turn.toolName}</strong> <code>{turn.text}</code></li>)}
      </ol>
    </details>
  );
}

export function ConversationView({ session, onOpenTerminal }: { session: Session; onOpenTerminal: () => void }) {
  const draftKey = `agentdeck:conversation-draft:${session.id}:${session.startedAt}`;
  const [body, setBody] = useState<ConversationBody | null>(null);
  const [draft, setDraft] = useState(() => {
    try { return window.sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; }
  });
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (draft) window.sessionStorage.setItem(draftKey, draft);
      else window.sessionStorage.removeItem(draftKey);
    } catch { /* storage unavailable — keep the draft in memory */ }
  }, [draft, draftKey]);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/conversation`);
      if (!response.ok) return;
      const next = await response.json() as ConversationBody;
      if (!Array.isArray(next.turns)) return;
      setBody(next);
      setPending((current) => (current && next.turns.some((turn) => turn.role === 'user' && turn.text.trim() === current.trim()) ? null : current));
    } catch { /* offline — keep what we have, try again next tick */ }
  }, [session.id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const turnCount = body?.turns.length ?? 0;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [turnCount, pending, following]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < STICKY_PX);
  };

  const live = session.status !== 'exited' && session.status !== 'completed';
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not send.');
      setDraft('');
      setPending(text);
      setFollowing(true);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const agentName = session.agent === 'claude' ? 'Claude' : 'Codex';
  const items = groupTurns(body?.turns ?? []);
  const working = session.status === 'working' || session.status === 'starting' || pending !== null;

  return (
    <div className="conversation">
      <div className="conversation-scroll" onScroll={onScroll} ref={scrollRef}>
        <div className="conversation-column">
          {!body && <p className="conversation-empty">Loading conversation…</p>}
          {body && !body.found && items.length === 0 && (
            <p className="conversation-empty">
              {agentName} hasn’t written anything for this session yet. Messages appear here as soon as it starts its first reply.
            </p>
          )}
          {items.map((item) => item.kind === 'tools'
            ? <ToolGroup key={item.id} turns={item.turns} />
            : (
              <div className={`conversation-message is-${item.turn.role}`} key={item.turn.id}>
                {item.turn.role === 'assistant' && <span aria-hidden className="conversation-avatar">{agentName[0]}</span>}
                <div className="conversation-bubble">
                  {item.turn.role === 'assistant' ? <Markdown text={item.turn.text} /> : <p>{item.turn.text}</p>}
                </div>
              </div>
            ))}
          {pending && (
            <div className="conversation-message is-user is-pending">
              <div className="conversation-bubble"><p>{pending}</p></div>
            </div>
          )}
          {live && working && <div aria-live="polite" className="conversation-working"><span /><span /><span /> {agentName} is working</div>}
          {live && session.status === 'waiting_input' && (
            <div className="conversation-waiting" role="status">
              {agentName} is waiting for you — it may be asking for approval or a choice.
              <button className="text-button" onClick={onOpenTerminal} type="button">Open Terminal</button>
            </div>
          )}
        </div>
      </div>
      {!following && (
        <button className="conversation-jump" onClick={() => { setFollowing(true); }} type="button">↓ Latest</button>
      )}
      <form className="conversation-composer" onSubmit={(event) => void send(event)}>
        <textarea
          aria-label={`Message ${agentName}`}
          disabled={!live}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={live ? `Message ${agentName}… (Enter to send, Shift+Enter for a new line)` : 'This session has ended.'}
          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          value={draft}
        />
        <button aria-label="Send" className="conversation-send" disabled={!live || sending || !draft.trim()} type="submit">↑</button>
      </form>
      {error && <div className="form-error conversation-error" role="alert">{error}</div>}
    </div>
  );
}
