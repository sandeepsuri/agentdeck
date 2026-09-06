import { useEffect, useRef, useState } from 'react';
import type { CollaboratorSession, CollaboratorSessionCapabilities, SessionChatMessage } from '../../types.js';
import { parseMention } from '../../mentions.js';
import { getSessionCapabilities, listChatMessages, postChatMessage } from '../collaboratorSessions.js';
import { relativeTime } from './model.js';

type ChatSession = Pick<CollaboratorSession, 'id' | 'agent' | 'name' | 'startedAt' | 'branch'>;
function runtimeLabel(session: ChatSession): string {
  return session.agent === 'claude' ? 'Claude Code' : 'Codex';
}
function agentLabel(session: ChatSession): string {
  return session.name ?? runtimeLabel(session);
}

function deliveryLabel(message: SessionChatMessage): string | null {
  if (message.audience !== 'agent') return null;
  if (message.delivery === 'sent') return 'Sent to agent';
  if (message.delivery === 'queued') return 'Waiting for the agent’s next turn';
  if (message.delivery === 'not_sent') return `Not sent${message.deliveryReason ? ` — ${message.deliveryReason}` : ''}`;
  return null;
}

/**
 * The composer at the Session level: a message goes to every participant.
 * It reaches the agent only when the author writes an explicit @agent
 * mention — the same parser (../../mentions.js) the server enforces, used
 * here only to preview the destination before submission, never to decide
 * it. `capabilities` still comes from the server's own pure check, but it no
 * longer gates the composer itself: chat stays available even when the
 * agent cannot be reached, so an
 * addressed message is still posted and shown "Not sent" with why.
 */
function ChatComposer({ sessionId, runtimeLabel, capabilities, onError, onSent }: {
  sessionId: string;
  runtimeLabel: string;
  capabilities: CollaboratorSessionCapabilities | null;
  onError: (message: string) => void;
  onSent: (message: SessionChatMessage) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const mention = parseMention(text);
  const agentUnavailable = capabilities?.send === 'unavailable';

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const message = await postChatMessage(sessionId, value);
      setText('');
      onSent(message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="mobile-request-composer mobile-agent-composer"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <textarea
        aria-label="Message everyone"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // IME composition (accents, CJK input) must not submit on Enter.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Message everyone · mention @agent to ask the agent…"
        rows={2}
        value={text}
      />
      <div className="mobile-agent-composer-actions">
        <button
          className="mobile-mention-button"
          onClick={() => setText((current) => (current.trim().length > 0 ? `${current.trimEnd()} @agent ` : '@agent '))}
          type="button"
        >
          Mention @agent
        </button>
        <button className="is-primary" disabled={!text.trim() || sending} type="submit">
          {sending ? 'Sending…' : mention.mentioned ? 'Send to agent' : 'Send to chat'}
        </button>
      </div>
      <small className="mobile-agent-hint">
        {mention.mentioned
          ? (agentUnavailable
            ? (capabilities?.reason ?? 'This agent cannot receive messages right now.')
            : `Visible to everyone here, and delivered to ${runtimeLabel}.`)
          : 'Visible to everyone here. Mention @agent to ask the agent.'}
      </small>
    </form>
  );
}

/** A Session's conversation: the shared, attributed message feed, styled as the Run conversation is, never a terminal. */
function AgentConversation({ session, principal, messages, loading }: {
  session: Pick<CollaboratorSession, 'id' | 'agent' | 'name' | 'startedAt' | 'branch'>;
  principal?: { id: string; displayName: string };
  messages: readonly SessionChatMessage[];
  loading: boolean;
}) {
  return (
    <main className="mobile-conversation">
      <section className="mobile-run-intent">
        <h2>{agentLabel(session)}</h2>
        <small>
          {runtimeLabel(session)} · started {relativeTime(session.startedAt)}
          {session.branch ? ` · ${session.branch}` : ''}
        </small>
      </section>

      {messages.length > 0 && (
        <ol aria-label="Conversation" className="mobile-agent-messages">
          {messages.map((message) => {
            // The server names an agent turn's displayName the same way
            // runtimeLabel() does (session-conversation.ts's
            // agentDisplayName), so every row's own displayName is already
            // the right thing to show — no author-kind branch needed here.
            const isSelf = message.authorKind === 'human' && message.principalId !== undefined
              && message.principalId === principal?.id;
            const delivery = deliveryLabel(message);
            return (
              <li
                className={`mobile-agent-message is-${message.authorKind}${message.event === 'done' ? ' is-done' : ''}${message.audience === 'agent' ? ' is-addressed' : ''}`}
                key={message.id}
              >
                <small>{message.displayName}{isSelf ? ' (you)' : ''} · {relativeTime(message.ts)}</small>
                <p>{message.text}</p>
                {delivery && <small className="mobile-message-delivery">{delivery}</small>}
              </li>
            );
          })}
        </ol>
      )}

      {messages.length === 0 && (
        <p className="mobile-run-waiting">
          {loading
            ? 'Loading this conversation…'
            : 'Nothing has been said in this conversation yet. Send the first message below.'}
        </p>
      )}
    </main>
  );
}

export function SessionChat({ session, principal, onError }: {
  session: ChatSession;
  principal?: { id: string; displayName: string };
  onError: (message: string) => void;
}) {
  const [capabilities, setCapabilities] = useState<CollaboratorSessionCapabilities | null>(null);
  const [messages, setMessages] = useState<SessionChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const posted = useRef(new Map<string, SessionChatMessage>());

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [next, capability] = await Promise.all([
          listChatMessages(session.id),
          getSessionCapabilities(session.id).catch(() => null),
        ]);
        if (disposed) return;
        // Keep successful posts visible if an older poll completes after POST.
        for (const message of next) posted.current.delete(message.id);
        const merged = new Map(next.map((message) => [message.id, message]));
        for (const [id, message] of posted.current) merged.set(id, message);
        setMessages([...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-100));
        setCapabilities(capability);
        setLoaded(true);
        setLoadError(false);
      } catch {
        if (disposed) return;
        setLoadError(true);
      }
      // Humans can keep talking after the runtime exits.
      if (!disposed) timer = setTimeout(() => { void tick(); }, 2000);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [session.id]);

  return <section aria-label="Shared session chat" className="session-chat">
    {loadError && <p role="status" className="mobile-agent-hint">Unable to refresh the conversation. Retrying…</p>}
    <AgentConversation session={session} principal={principal} messages={messages} loading={!loaded} />
    <ChatComposer sessionId={session.id} runtimeLabel={runtimeLabel(session)} capabilities={capabilities} onError={onError}
      onSent={(message) => {
        posted.current.set(message.id, message);
        setMessages((current) => [...current.filter((item) => item.id !== message.id), message].slice(-100));
      }} />
  </section>;
}
