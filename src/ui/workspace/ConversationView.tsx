// Conversation: the session's exchange with its agent as a chat — your
// messages on the right, the agent's replies on the left, its tool calls
// folded into one line per stretch of work. Read from the agent's own
// transcript (GET /api/sessions/:id/conversation), so it is exactly what the
// agent saw and said, with none of the TUI's redraw noise. The composer types
// into the live session through the same /send path as the terminal
// composer. A multiple-choice question the agent opens (Claude's
// AskUserQuestion, Codex's request_user_input) is answered here as a card;
// permission approvals still happen in the Terminal tab. Typing "/" opens a
// picker of the session's skills and slash commands.
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationTurn, ConversationView as ConversationBody } from '../../sessions/conversation.js';
import type { SkillEntry } from '../../sessions/skill-catalog.js';
import type { Session } from '../../types.js';
import { apiFetch } from '../apiFetch.js';
import { Markdown } from './markdown.js';
import { SlashMenu, filterSkills, slashOptionId, slashQuery } from './SlashMenu.js';

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

type OpenQuestion = NonNullable<ConversationBody['question']>;
interface Draft { selected: number[]; other: string }

/** The agent's open multiple-choice question, answerable here instead of in the Terminal. */
export function QuestionCard({ sessionId, agentName, question, onAnswered, onOpenTerminal }: {
  sessionId: string; agentName: string; question: OpenQuestion; onAnswered: () => void; onOpenTerminal: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => question.questions.map(() => ({ selected: [], other: '' })));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, change: (draft: Draft) => Draft) =>
    setDrafts((current) => current.map((draft, at) => (at === index ? change(draft) : draft)));
  const complete = drafts.every((draft) => draft.selected.length > 0 || draft.other.trim());
  const answerable = question.canAnswer !== false;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversation/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionId: question.id,
          answers: drafts.map((draft) => ({ selected: draft.selected, ...(draft.other.trim() ? { other: draft.other.trim() } : {}) })),
        }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not send the answer.');
      onAnswered();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };

  return (
    <form aria-label={`${agentName} is asking`} className="conversation-question" onSubmit={(event) => void submit(event)}>
      <span className="conversation-question-label">{agentName} is asking</span>
      {question.questions.map((item, index) => {
        const draft = drafts[index]!;
        return (
          <fieldset disabled={!answerable || sending} key={`${index}:${item.question}`}>
            <legend>
              {item.header && <span className="conversation-question-header">{item.header}</span>}
              {item.question}
              {item.multiSelect && <small> · choose any</small>}
            </legend>
            {item.options.map((option, optionIndex) => (
              <label className="conversation-question-option" key={`${optionIndex}:${option.label}`}>
                <input
                  checked={draft.selected.includes(optionIndex)}
                  name={`${question.id}:${index}`}
                  onChange={() => update(index, (current) => (item.multiSelect
                    ? { ...current, selected: current.selected.includes(optionIndex)
                      ? current.selected.filter((value) => value !== optionIndex) : [...current.selected, optionIndex] }
                    : { selected: [optionIndex], other: '' }))}
                  type={item.multiSelect ? 'checkbox' : 'radio'}
                />
                <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              </label>
            ))}
            <input
              aria-label={`Other answer to ${item.question}`}
              className="conversation-question-other"
              onChange={(event) => {
                const other = event.target.value;
                update(index, (current) => ({ selected: item.multiSelect || !other.trim() ? current.selected : [], other }));
              }}
              placeholder="Or type your own answer…"
              type="text"
              value={draft.other}
            />
          </fieldset>
        );
      })}
      {answerable ? (
        <div className="conversation-question-actions">
          <button className="button button-primary" disabled={!complete || sending} type="submit">{sending ? 'Sending…' : 'Send answer'}</button>
          <button className="text-button" onClick={onOpenTerminal} type="button">Answer in Terminal</button>
        </div>
      ) : (
        <p className="conversation-question-note">
          AgentDeck can’t reach this session’s terminal, so answer it there.
          <button className="text-button" onClick={onOpenTerminal} type="button">Open Terminal</button>
        </p>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </form>
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
  /** The question just answered here: hidden until the transcript records the answer. */
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashListId = useId();
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  /** The draft the picker was closed on with Esc; it reopens once the draft changes. */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);

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
  }, [turnCount, pending, following, body?.question?.id]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < STICKY_PX);
  };

  const live = session.status !== 'exited' && session.status !== 'completed';
  const query = session.agent === 'claude' && live && draft !== slashDismissed ? slashQuery(draft) : undefined;
  const slashOpen = query !== undefined;
  const slashItems = slashOpen ? filterSkills(skills ?? [], query) : [];
  const slashActive = Math.min(slashIndex, Math.max(0, slashItems.length - 1));

  // Re-read the list each time the picker opens, so a skill added mid-session shows up.
  useEffect(() => {
    if (!slashOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/skills`);
        const next = response.ok ? await response.json() as { skills?: SkillEntry[] } : undefined;
        if (!cancelled) setSkills(Array.isArray(next?.skills) ? next.skills : []);
      } catch {
        if (!cancelled) setSkills((current) => current ?? []);
      }
    })();
    return () => { cancelled = true; };
  }, [slashOpen, session.id]);

  const pickSkill = (skill: SkillEntry) => {
    setDraft(`/${skill.name} `);
    setSlashIndex(0);
    textareaRef.current?.focus();
  };
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
    if (slashOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(draft);
        return;
      }
      if (slashItems.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setSlashIndex((slashActive + direction + slashItems.length) % slashItems.length);
        return;
      }
      // Enter on a name typed out in full sends it; otherwise it completes the highlighted one.
      const typedInFull = slashItems[slashActive]?.name === query;
      if (slashItems.length > 0 && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !typedInFull))) {
        event.preventDefault();
        pickSkill(slashItems[slashActive]!);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const agentName = session.agent === 'claude' ? 'Claude' : 'Codex';
  const items = groupTurns(body?.turns ?? []);
  const working = session.status === 'working' || session.status === 'starting' || pending !== null;
  const question = live && body?.question && body.question.id !== answeredId ? body.question : undefined;

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
          {question && (
            <QuestionCard agentName={agentName} key={question.id} onAnswered={() => { setAnsweredId(question.id); setFollowing(true); void load(); }}
              onOpenTerminal={onOpenTerminal} question={question} sessionId={session.id} />
          )}
          {live && working && !question && <div aria-live="polite" className="conversation-working"><span /><span /><span /> {agentName} is working</div>}
          {live && session.status === 'waiting_input' && !question && (
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
        {slashOpen && (
          <SlashMenu activeIndex={slashActive} id={slashListId} items={slashItems} loading={skills === null}
            onHover={setSlashIndex} onPick={pickSkill} />
        )}
        <textarea
          aria-activedescendant={slashOpen && slashItems.length > 0 ? slashOptionId(slashListId, slashActive) : undefined}
          aria-autocomplete="list"
          aria-controls={slashOpen ? slashListId : undefined}
          aria-expanded={slashOpen}
          aria-label={`Message ${agentName}`}
          disabled={!live}
          onChange={(event) => { setDraft(event.target.value); setSlashIndex(0); }}
          onKeyDown={onKeyDown}
          placeholder={live ? `Message ${agentName}… (Enter to send, Shift+Enter for a new line${session.agent === 'claude' ? ', / for skills' : ''})` : 'This session has ended.'}
          ref={textareaRef}
          role="combobox"
          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          value={draft}
        />
        <button aria-label="Send" className="conversation-send" disabled={!live || sending || !draft.trim()} type="submit">↑</button>
      </form>
      {error && <div className="form-error conversation-error" role="alert">{error}</div>}
    </div>
  );
}
