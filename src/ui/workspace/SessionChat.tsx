import { useEffect, useRef, useState } from 'react';
import type {
  CollaboratorSession, CollaboratorSessionCapabilities, SessionInteraction, SessionInteractionsView, SessionChatMessage,
} from '../../types.js';
import { parseMention } from '../../mentions.js';
import {
  getSessionCapabilities, getSessionInteractions, listChatMessages, postChatMessage, respondToSessionInteraction,
} from '../collaboratorSessions.js';
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
  if (message.delivery === 'sent') return 'Sent to terminal · awaiting provider activity';
  if (message.delivery === 'queued') return 'Waiting for the agent’s next turn';
  if (message.delivery === 'not_sent') return `Not sent${message.deliveryReason ? ` — ${message.deliveryReason}` : ''}`;
  return null;
}

const processingLabels: Record<SessionInteractionsView['processingState'], string> = {
  delivery_pending: 'Delivery pending', working: 'Working…', waiting_answer: 'Waiting for your answer',
  waiting_approval: 'Waiting for approval', finished: 'Finished', failed: 'Failed', disconnected: 'Disconnected', idle: 'Ready',
};

function InteractionCard({ sessionId, interaction, onResolved, onError }: {
  sessionId: string; interaction: SessionInteraction; onResolved: (value: SessionInteraction) => void; onError: (value: string) => void;
}) {
  const grouped = new Map<string, SessionInteraction['choices']>();
  for (const choice of interaction.choices) {
    const question = choice.questionId ?? interaction.question;
    grouped.set(question, [...(grouped.get(question) ?? []), choice]);
  }
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [hasFreeText, setHasFreeText] = useState(false);
  const [busy, setBusy] = useState(false);
  const respond = async (body: { answers: Record<string, string[]>; freeText?: boolean } | { decision: 'approve' | 'deny' }) => {
    setBusy(true);
    try { onResolved(await respondToSessionInteraction(sessionId, interaction.id, body)); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <li className={`session-interaction is-${interaction.kind}`}>
    <strong>{interaction.kind === 'approval' ? 'Permission approval' : 'Agent question'}</strong>
    <p>{interaction.question}</p>
    {interaction.context && <pre>{interaction.context}</pre>}
    {interaction.status === 'resolved' ? <small>
      Answered by {interaction.responderDisplayName ?? 'an authorized participant'}
      {interaction.response?.kind === 'approval' ? ` · ${interaction.response.decision === 'approve' ? 'Approved' : 'Denied'}` : ''}
    </small> : interaction.canRespond ? interaction.kind === 'approval' ? <div className="mobile-agent-composer-actions">
      <button disabled={busy} onClick={() => void respond({ decision: 'approve' })} type="button">Approve</button>
      <button disabled={busy} onClick={() => void respond({ decision: 'deny' })} type="button">Deny</button>
    </div> : <form onSubmit={(event) => { event.preventDefault(); void respond({ answers, ...(hasFreeText ? { freeText: true } : {}) }); }}>
      {[...grouped].map(([question, choices]) => <fieldset key={question}>
        <legend>{question}</legend>
        {choices.map((choice) => <label key={`${question}:${choice.id}`}>
          <input checked={answers[question]?.includes(choice.id) ?? false} name={`${interaction.id}:${question}`} onChange={() => setAnswers((current) => ({
            ...current,
            [question]: choice.multiple
              ? (current[question]?.includes(choice.id) ? current[question]!.filter((value) => value !== choice.id) : [...(current[question] ?? []), choice.id])
              : [choice.id],
          }))} type={choice.multiple ? 'checkbox' : 'radio'} />
          {choice.label}{choice.description ? ` — ${choice.description}` : ''}
        </label>)}
        {interaction.allowsFreeText && <label>Other answer
          <input onChange={(event) => {
            const value = event.target.value.trim();
            setHasFreeText(Boolean(value));
            setAnswers((current) => ({ ...current, [question]: value ? [value] : [] }));
          }} type="text" />
        </label>}
      </fieldset>)}
      <button disabled={busy || [...grouped.keys()].some((question) => !answers[question]?.length)} type="submit">{busy ? 'Sending…' : 'Send answer'}</button>
    </form> : <small>{interaction.unavailableReason ?? 'This request can no longer be answered.'}</small>}
  </li>;
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
  const [interactionView, setInteractionView] = useState<SessionInteractionsView | null>(null);
  const posted = useRef(new Map<string, SessionChatMessage>());

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    posted.current.clear();
    setMessages([]);
    setInteractionView(null);
    setLoaded(false);
    const tick = async () => {
      try {
        const [next, capability, interactions] = await Promise.all([
          listChatMessages(session.id),
          getSessionCapabilities(session.id).catch(() => null),
          getSessionInteractions(session.id).catch(() => null),
        ]);
        if (disposed) return;
        // Keep successful posts visible if an older poll completes after POST.
        for (const message of next) posted.current.delete(message.id);
        const merged = new Map(next.map((message) => [message.id, message]));
        for (const [id, message] of posted.current) merged.set(id, message);
        setMessages([...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-100));
        setCapabilities(capability);
        if (interactions && !Array.isArray(interactions) && Array.isArray(interactions.interactions)) setInteractionView(interactions);
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

  const replaceInteraction = (next: SessionInteraction) => setInteractionView((current) => current ? {
    ...current, processingState: 'delivery_pending',
    interactions: current.interactions.map((item) => item.id === next.id ? next : item),
  } : current);

  return <section aria-label="Shared session chat" className="session-chat">
    {loadError && <p role="status" className="mobile-agent-hint">Unable to refresh the conversation. Retrying…</p>}
    {interactionView && <div className="session-processing" role="status">
      {interactionView.processingState === 'working' ? `${session.agent === 'claude' ? 'Claude' : 'Codex'} is working…` : processingLabels[interactionView.processingState]}
      {interactionView.processingReason ? ` — ${interactionView.processingReason}` : ''}
    </div>}
    {interactionView?.providerSupport === 'unavailable' && <p className="mobile-agent-hint">{interactionView.providerReason}</p>}
    {interactionView && interactionView.interactions.length > 0 && <ol aria-label="Agent requests" className="session-interactions">
      {interactionView.interactions.map((interaction) => <InteractionCard key={interaction.id} sessionId={session.id} interaction={interaction}
        onError={onError} onResolved={replaceInteraction} />)}
    </ol>}
    <AgentConversation session={session} principal={principal} messages={messages} loading={!loaded} />
    <ChatComposer sessionId={session.id} runtimeLabel={runtimeLabel(session)} capabilities={capabilities} onError={onError}
      onSent={(message) => {
        posted.current.set(message.id, message);
        setMessages((current) => [...current.filter((item) => item.id !== message.id), message].slice(-100));
        if (message.audience === 'agent' && (message.delivery === 'sent' || message.delivery === 'queued')) {
          setInteractionView((current) => current ? { ...current, processingState: 'delivery_pending' } : current);
        }
      }} />
  </section>;
}
