// The Collaborator workspace: one repo-scoped place to see what work has been
// done, follow what is running, and ask for more.
//
// Before this, a Collaborator's phone rendered MobileWorkspace's session tree
// — which is built entirely around Sessions they cannot reach (app.ts refuses
// them GET /api/sessions, and ws.ts refuses them 'attach'), so the drawer was
// permanently empty — plus a '+' button whose Run went to 'queued' and stayed
// there. Three disconnected things, none of which worked end to end.
//
// So this is deliberately NOT a session view with Runs bolted on. It is one
// navigation stack — Repository, then the work in it, then one piece of that
// work's conversation — with a single composer at the bottom whose meaning
// follows the level you are at: "request work in this Repository", "answer
// this Run", or "message this agent". The Repository is the top of the stack
// because the Repository is exactly what a grant is about; there is no level
// above it a Collaborator could navigate to.
//
// A granted Repository has two kinds of work happening in it, and both hang
// off that one level: the Runs requested against it, and the agents already
// running in it. They are listed as one feed rather than two tabs, because
// "what is happening in this Repository" is a single question.
//
// "Chat" here is never a terminal. A Run's conversation is
// attempt-narrative.ts's derived labels over the durable Attempt event log; a
// Session's is the same message list the admin's own chat view reads, polled
// over grant-scoped REST. A collaborator socket is still refused 'attach' and
// both session broadcasts (ws.ts), so no PTY bytes and no machine-wide view
// of Sessions ever reach here.
import { useEffect, useRef, useState } from 'react';
import type {
  AgentType, CollaboratorSession, CollaboratorSessionCapabilities, CollaboratorSessionMessage, Repo,
} from '../../types.js';
import type {
  AttentionDecisionInput, CollaboratorRunDetail, CollaboratorRunSummary, Profile, WorkSpec,
} from '../../work-engine/types.js';
import { describeOutcome, formatTokenCount } from '../../work-engine/attempt-narrative.js';
import { getCollaboratorRun, requestWork } from '../collaboratorRuns.js';
import { getSessionCapabilities, listSessionMessages, sendSessionMessage } from '../collaboratorSessions.js';
import { lines } from '../components/RunSubmissionModal.js';
import { STATUS_LABELS, relativeTime } from './model.js';
import { formatRunLabel, isTerminalRunStatus } from './runModel.js';

export interface Props {
  principal: { id: string; displayName: string };
  /** Already grant-filtered and narrowed by the server (GET /api/repos). */
  repos: Repo[];
  profiles: Profile[];
  /** Already grant-filtered and narrowed by the server (GET /api/runs). */
  runs: CollaboratorRunSummary[];
  /** Already grant-filtered and narrowed by the server (GET /api/sessions) — agents running in a granted Repository, never a Session this device could attach to. */
  sessions: CollaboratorSession[];
  onError: (message: string) => void;
  /** Pulls the Run list forward immediately after a request, rather than waiting for the next poll. */
  onRunsStale: () => void;
  onResolveRunAttention: (runId: string, attentionId: string, decision: AttentionDecisionInput) => void;
  /** Drops this device's credential and returns to the gate. Optional so existing callers/tests need no change. */
  onSignOut?: () => void;
}

type View =
  | { kind: 'repository'; repositoryId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'session'; sessionId: string };

const STATUS_MARK: Record<'started' | 'completed' | 'failed', string> = {
  started: '…', completed: '✓', failed: '✕',
};

/** Non-terminal Runs first (they are what someone is here to watch), then the rest newest-first. */
function orderRuns(runs: readonly CollaboratorRunSummary[]): CollaboratorRunSummary[] {
  return [...runs].sort((a, b) => {
    const activeA = isTerminalRunStatus(a.status) ? 1 : 0;
    const activeB = isTerminalRunStatus(b.status) ? 1 : 0;
    if (activeA !== activeB) return activeA - activeB;
    return b.submittedAt.localeCompare(a.submittedAt);
  });
}

/** A Session's name if it has one — never sessionLabel(), which derives its fallback from `cwd`, a field this projection deliberately does not carry. */
function agentLabel(session: CollaboratorSession): string {
  return session.name ?? (session.agent === 'claude' ? 'Claude Code' : 'Codex');
}

/** Same rule as orderRuns: what is still running comes first, then the rest by most recent activity. */
function orderSessions(sessions: readonly CollaboratorSession[]): CollaboratorSession[] {
  return [...sessions].sort((a, b) => {
    const endedA = a.status === 'exited' ? 1 : 0;
    const endedB = b.status === 'exited' ? 1 : 0;
    if (endedA !== endedB) return endedA - endedB;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

function MenuIcon() {
  return <span aria-hidden="true" className="mobile-menu-icon"><i /><i /><i /></span>;
}

function RepositoryDrawer({ open, repos, runs, sessions, selectedId, onClose, onSelect }: {
  open: boolean;
  repos: Repo[];
  runs: readonly CollaboratorRunSummary[];
  sessions: readonly CollaboratorSession[];
  selectedId: string | null;
  onClose: () => void;
  onSelect: (repositoryId: string) => void;
}) {
  return (
    <>
      <button
        aria-hidden={!open}
        aria-label="Close repositories"
        className={`mobile-drawer-scrim${open ? ' is-open' : ''}`}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        type="button"
      />
      <aside aria-hidden={!open} aria-modal={open || undefined} className={`mobile-session-drawer${open ? ' is-open' : ''}`} role="dialog">
        <header className="mobile-drawer-header">
          <span className="mobile-drawer-brand"><strong>AgentDeck</strong></span>
          <button aria-label="Close repositories" className="mobile-icon-button" onClick={onClose} tabIndex={open ? 0 : -1} type="button">×</button>
        </header>

        <div className="mobile-drawer-label">Your repositories</div>
        <nav aria-label="Your repositories" className="mobile-session-list">
          {repos.map((repo) => {
            const activeRuns = runs.filter((run) => run.repository.id === repo.id && !isTerminalRunStatus(run.status)).length;
            const activeAgents = sessions.filter((item) => item.repoId === repo.id && item.status !== 'exited').length;
            const active = activeRuns + activeAgents;
            return (
              <button
                className={`mobile-repo-row${repo.id === selectedId ? ' is-selected' : ''}`}
                data-repo-id={repo.id}
                key={repo.id}
                onClick={() => { onSelect(repo.id); onClose(); }}
                tabIndex={open ? 0 : -1}
                type="button"
              >
                <span className="mobile-session-copy">
                  <strong>{repo.name}</strong>
                  <small>{active > 0 ? `${active} active` : 'Nothing in progress'}</small>
                </span>
                {active > 0 && <span aria-hidden="true" className="mobile-repo-count">{active}</span>}
              </button>
            );
          })}
          {repos.length === 0 && <p className="mobile-session-empty">No Repositories have been granted to you yet.</p>}
        </nav>

        <footer className="mobile-drawer-footer">
          <span aria-hidden="true" className="mobile-lock">⌁</span>
          <span><strong>Private connection</strong><small>Tailscale protected</small></span>
        </footer>
      </aside>
    </>
  );
}

function RunTile({ run, onSelect }: { run: CollaboratorRunSummary; onSelect: () => void }) {
  const terminal = isTerminalRunStatus(run.status);
  return (
    <button
      className={`mobile-run-tile${terminal ? ' is-terminal' : ' is-active'}`}
      data-run-id={run.id}
      onClick={onSelect}
      type="button"
    >
      <span className="mobile-run-tile-head">
        <span aria-hidden="true" className={`mobile-run-dot status-${run.status}`} />
        <strong>{run.objective}</strong>
      </span>
      <span className="mobile-run-tile-meta">
        <span className={`mobile-run-status status-${run.status}`}>{formatRunLabel(run.status)}</span>
        <small>{run.requestedBy} · {relativeTime(run.submittedAt)}</small>
      </span>
      {run.pendingAttentionKind && (
        <span className="mobile-run-badge">
          {run.pendingAttentionKind === 'approval' ? 'Needs your approval' : 'Needs your input'}
        </span>
      )}
      {run.preparation.note && <span className="mobile-run-blocked">{run.preparation.note}</span>}
    </button>
  );
}

/** An agent running in this Repository. Deliberately the same tile shape as RunTile so the two read as one feed rather than two lists that happen to sit together. */
function AgentTile({ session, onSelect }: { session: CollaboratorSession; onSelect: () => void }) {
  const ended = session.status === 'exited';
  return (
    <button
      className={`mobile-run-tile mobile-agent-tile${ended ? ' is-terminal' : ' is-active'}`}
      data-session-id={session.id}
      onClick={onSelect}
      type="button"
    >
      <span className="mobile-run-tile-head">
        <span aria-hidden="true" className={`mobile-status-dot status-${session.status}`} />
        <strong>{agentLabel(session)}</strong>
      </span>
      <span className="mobile-run-tile-meta">
        <span className={`mobile-run-status status-${session.status}`}>{STATUS_LABELS[session.status]}</span>
        <small>{session.agent === 'claude' ? 'Claude Code' : 'Codex'} · {relativeTime(session.lastActivityAt)}</small>
      </span>
      {session.status === 'waiting_input' && <span className="mobile-run-badge">Waiting for a reply</span>}
    </button>
  );
}

/**
 * The composer at the Session level: message a running agent.
 *
 * `capabilities` comes from the server's own pure check, the same one its send
 * route applies, so this is never offered for a Session that would then refuse
 * the message — and when it cannot be offered the reader is told why rather
 * than left with a dead input.
 */
function AgentComposer({ sessionId, capabilities, onError, onSent }: {
  sessionId: string;
  capabilities: CollaboratorSessionCapabilities | null;
  onError: (message: string) => void;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (capabilities && capabilities.send === 'unavailable') {
    return <p className="mobile-agent-closed" role="status">{capabilities.reason}</p>;
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await sendSessionMessage(sessionId, value);
      setText('');
      onSent();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="mobile-request-composer mobile-agent-composer" onSubmit={(event) => { void submit(event); }}>
      <textarea
        aria-label="Message this agent"
        onChange={(event) => setText(event.target.value)}
        placeholder="Message this agent…"
        rows={2}
        value={text}
      />
      <button className="is-primary" disabled={!text.trim() || sending} type="submit">
        {sending ? 'Sending…' : 'Send'}
      </button>
      {capabilities?.send === 'queued' && (
        <small className="mobile-agent-hint">
          This agent is running in someone else&rsquo;s terminal, so your message is delivered on its next turn.
        </small>
      )}
    </form>
  );
}

/** A Session's conversation: the message list, styled as the Run conversation is, never a terminal. */
function AgentConversation({ session, messages, loading }: {
  session: CollaboratorSession;
  messages: readonly CollaboratorSessionMessage[];
  loading: boolean;
}) {
  return (
    <main className="mobile-conversation">
      <section className="mobile-run-intent">
        <h2>{agentLabel(session)}</h2>
        <small>
          {session.agent === 'claude' ? 'Claude Code' : 'Codex'} · started {relativeTime(session.startedAt)}
          {session.branch ? ` · ${session.branch}` : ''}
        </small>
      </section>

      {messages.length > 0 && (
        <ol aria-label="Conversation" className="mobile-agent-messages">
          {messages.map((message, index) => (
            <li
              className={`mobile-agent-message is-${message.author}${message.event === 'done' ? ' is-done' : ''}`}
              key={`${message.ts}-${index}`}
            >
              <small>{message.author === 'human' ? 'You' : agentLabel(session)} · {relativeTime(message.ts)}</small>
              <p>{message.text}</p>
            </li>
          ))}
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

/** The composer at the Repository level: this is what "request a new task" is. */
function RequestWorkComposer({ repository, profiles, onError, onRequested }: {
  repository: Repo;
  profiles: Profile[];
  onError: (message: string) => void;
  onRequested: (runId: string, note?: string) => void;
}) {
  const [objective, setObjective] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (!profileId && profiles[0]) setProfileId(profiles[0].id); }, [profileId, profiles]);

  if (profiles.length === 0) {
    return (
      <footer className="mobile-request-composer">
        <p className="mobile-request-empty">No Profiles have been granted to you yet, so work can't be requested. Ask the admin to grant one.</p>
      </footer>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile || !objective.trim() || !acceptanceCriteria.trim()) return;
    // Runtime, budget, verification and delivery are filled from the Profile
    // purely so this form's own summary matches what will run — the Work
    // Engine overwrites all four from the Profile server-side regardless
    // (engine.ts's submit()), and now resolves the Repository from its own
    // store too, which is why `path` is empty here: a Collaborator is never
    // told a Repository's absolute path (server/routes.ts's scopeRepos).
    const spec: WorkSpec = {
      objective: objective.trim(),
      acceptanceCriteria: lines(acceptanceCriteria),
      repository: { id: repository.id, name: repository.name, path: '' },
      requestedBaseReference: repository.currentBranch ?? 'main',
      runtimePreference: [...profile.runtimePreference] as AgentType[],
      budget: { ...profile.budget },
      verificationIntent: { ...profile.verificationIntent },
      requestedDeliveryResult: profile.requestedDeliveryResult,
      profileId: profile.id,
    };
    setSubmitting(true);
    try {
      const outcome = await requestWork(spec);
      setObjective('');
      setAcceptanceCriteria('');
      onRequested(outcome.runId, outcome.note);
    } catch (error) {
      // A refused submission created nothing, so the text stays in the form
      // rather than being cleared out from under the person who wrote it.
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer className="mobile-request-composer">
      <form onSubmit={(event) => { void submit(event); }}>
        <label>
          <span>What should be done in {repository.name}?</span>
          <textarea
            aria-label="Objective"
            onChange={(event) => setObjective(event.target.value)}
            placeholder="Describe the work…"
            required
            rows={2}
            value={objective}
          />
        </label>
        <label>
          <span>How will you know it worked?</span>
          <textarea
            aria-label="Acceptance criteria"
            onChange={(event) => setAcceptanceCriteria(event.target.value)}
            placeholder="One per line"
            required
            rows={2}
            value={acceptanceCriteria}
          />
        </label>
        <div className="mobile-request-actions">
          <label className="mobile-request-profile">
            <span>Profile</span>
            <select aria-label="Profile" onChange={(event) => setProfileId(event.target.value)} required value={profileId}>
              {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button className="is-primary" disabled={submitting || !objective.trim() || !acceptanceCriteria.trim()} type="submit">
            {submitting ? 'Requesting…' : 'Request work'}
          </button>
        </div>
      </form>
    </footer>
  );
}

/** Ticket 07's input-kind reply, inline in the Run conversation. */
function RunAttentionReply({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="mobile-run-attention-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim());
        setValue('');
      }}
    >
      <input aria-label="Clarifying input" onChange={(event) => setValue(event.target.value)} type="text" value={value} />
      <button className="is-primary" disabled={!value.trim()} type="submit">Send</button>
    </form>
  );
}

function RunResultPanel({ result }: { result: NonNullable<CollaboratorRunDetail['result']> }) {
  return (
    <section aria-label="Run result" className="mobile-run-result">
      <h3>Result</h3>
      {result.recoveryNotes && <p className="mobile-run-result-note">{result.recoveryNotes}</p>}
      {result.commit && (
        <p className="mobile-run-result-commit">
          Committed <code>{result.commit.sha.slice(0, 12)}</code> on {result.commit.branch}
          {result.commit.signed ? ' · signed' : ''}
        </p>
      )}
      {result.changedFiles.length > 0 && (
        <>
          <h4>Files changed</h4>
          <ul className="mobile-run-files">
            {result.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
          </ul>
        </>
      )}
      {result.verification.length > 0 && (
        <>
          <h4>Verification</h4>
          <ul className="mobile-run-gates">
            {result.verification.map((gate) => (
              <li className={gate.passed ? 'is-passed' : 'is-failed'} key={gate.gate}>
                <span aria-hidden="true">{gate.passed ? '✓' : '✕'}</span>
                {gate.gate}{gate.required ? '' : ' (optional)'}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.approvals.length > 0 && (
        <>
          <h4>Decisions</h4>
          <ul className="mobile-run-approvals">
            {result.approvals.map((approval) => (
              <li key={approval.attentionId}>{formatRunLabel(approval.decision)} — {approval.reason}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RunConversation({ detail, onResolveRunAttention }: {
  detail: CollaboratorRunDetail;
  onResolveRunAttention: (runId: string, attentionId: string, decision: AttentionDecisionInput) => void;
}) {
  const { narrative, pendingAttention } = detail;
  const verdict = describeOutcome(narrative.outcome);
  return (
    <main className="mobile-conversation">
      <section className="mobile-run-intent">
        <h2>{detail.objective}</h2>
        <ul className="mobile-run-criteria">
          {detail.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
        </ul>
        <small>Requested by {detail.requestedBy} · {relativeTime(detail.submittedAt)} · base {detail.requestedBaseReference}</small>
      </section>

      {detail.preparation.note && <p className="mobile-run-blocked-banner" role="status">{detail.preparation.note}</p>}

      {narrative.answer && (
        <section aria-label="What the Run reported" className="mobile-run-answer">
          <h3>What it found</h3>
          <p>{narrative.answer}</p>
        </section>
      )}

      {narrative.steps.length > 0 && (
        <section aria-label="What the Run did" className="mobile-run-steps">
          <h3>What it did</h3>
          {narrative.stepsTruncated && <small className="mobile-run-truncated">Showing the most recent steps.</small>}
          <ol>
            {narrative.steps.map((step) => (
              <li className={`mobile-run-step status-${step.status}`} key={step.sequence}>
                <span aria-hidden="true">{STATUS_MARK[step.status]}</span>
                {step.label}
              </li>
            ))}
          </ol>
        </section>
      )}

      {verdict && (
        <p className={`mobile-run-verdict${narrative.outcome?.kind === 'failure' ? ' is-failure' : ' is-success'}`}>
          {verdict}
          {narrative.usage && (narrative.usage.inputTokens !== 'unknown' || narrative.usage.outputTokens !== 'unknown') && (
            <span> · {formatTokenCount(narrative.usage.inputTokens)} in / {formatTokenCount(narrative.usage.outputTokens)} out</span>
          )}
        </p>
      )}

      {narrative.steps.length === 0 && !narrative.answer && !detail.preparation.note && (
        <p className="mobile-run-waiting">
          {detail.attemptState === 'idle' ? 'Getting a workspace ready…' : 'Working…'}
        </p>
      )}

      {pendingAttention && (
        <section aria-labelledby="mobile-run-attention-title" className="mobile-approval-card mobile-run-attention-card">
          <span aria-hidden="true" className="mobile-approval-icon">!</span>
          <span className="mobile-approval-copy">
            <strong id="mobile-run-attention-title">
              {pendingAttention.kind === 'approval' ? 'Approval needed' : 'Input needed'}
            </strong>
            <small>{pendingAttention.reason}</small>
          </span>
          {pendingAttention.kind === 'approval' ? (
            <div aria-label="Run approval response" className="mobile-approval-actions" role="group">
              <button onClick={() => onResolveRunAttention(detail.id, pendingAttention.id, { kind: 'deny' })} type="button">Deny</button>
              <button
                className="is-primary"
                onClick={() => onResolveRunAttention(detail.id, pendingAttention.id, { kind: 'approve' })}
                type="button"
              >
                Approve
              </button>
            </div>
          ) : (
            <RunAttentionReply
              onSubmit={(value) => onResolveRunAttention(detail.id, pendingAttention.id, { kind: 'input', value })}
            />
          )}
        </section>
      )}

      {detail.result && <RunResultPanel result={detail.result} />}
    </main>
  );
}

export function CollaboratorWorkspace({
  principal, repos, profiles, runs, sessions, onError, onRunsStale, onResolveRunAttention, onSignOut,
}: Props) {
  const [view, setView] = useState<View | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<CollaboratorRunDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<CollaboratorSessionMessage[]>([]);
  const [capabilities, setCapabilities] = useState<CollaboratorSessionCapabilities | null>(null);
  const [messagesLoaded, setMessagesLoaded] = useState(false);

  // Land on the first granted Repository rather than an empty screen — with
  // one Repository granted (the common case) there is nothing to choose.
  useEffect(() => {
    if (view === null && repos[0]) setView({ kind: 'repository', repositoryId: repos[0].id });
  }, [repos, view]);

  const runId = view?.kind === 'run' ? view.runId : null;
  const detailRef = useRef<string | null>(null);
  useEffect(() => { detailRef.current = runId; if (!runId) setDetail(null); }, [runId]);

  // The open Run's own poll. Only one Run is ever open, and the detail
  // payload is the expensive one, so it lives here rather than in App's
  // list-level interval. It stops once the Run can no longer change.
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getCollaboratorRun(runId);
        if (disposed || detailRef.current !== runId) return;
        setDetail(next);
        if (!isTerminalRunStatus(next.status)) timer = setTimeout(() => { void tick(); }, 2000);
      } catch {
        if (!disposed) timer = setTimeout(() => { void tick(); }, 5000);
      }
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId]);

  const sessionId = view?.kind === 'session' ? view.sessionId : null;
  const openSession = sessions.find((item) => item.id === sessionId) ?? null;

  // Whether this Session can still be messaged is a property of the Session,
  // not of the conversation, so it is fetched once per Session rather than on
  // every tick of the poll below.
  useEffect(() => {
    if (!sessionId) { setCapabilities(null); return; }
    let disposed = false;
    getSessionCapabilities(sessionId)
      .then((next) => { if (!disposed) setCapabilities(next); })
      .catch(() => undefined); // a composer that stays hidden is the safe failure
    return () => { disposed = true; };
  }, [sessionId]);

  // The open Session's own poll — the same shape as the open Run's below:
  // one conversation is ever open, it is the expensive read, and it stops
  // once the Session can no longer say anything new. A collaborator socket
  // receives no session frames at all (ws.ts), so this poll is the only
  // thing keeping the conversation current.
  const messagesRef = useRef<string | null>(null);
  useEffect(() => { messagesRef.current = sessionId; if (!sessionId) { setMessages([]); setMessagesLoaded(false); } }, [sessionId]);
  const sessionEnded = openSession?.status === 'exited';
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await listSessionMessages(sessionId);
        if (disposed || messagesRef.current !== sessionId) return;
        setMessages(next);
        setMessagesLoaded(true);
        if (!sessionEnded) timer = setTimeout(() => { void tick(); }, 2000);
      } catch {
        if (!disposed) timer = setTimeout(() => { void tick(); }, 5000);
      }
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionEnded, sessionId]);

  const repository = repos.find((repo) => repo.id === (
    view?.kind === 'repository' ? view.repositoryId
      : view?.kind === 'session' ? openSession?.repoId
        : detail?.repository.id
  ));
  const repositoryRuns = repository ? orderRuns(runs.filter((run) => run.repository.id === repository.id)) : [];
  const repositorySessions = repository ? orderSessions(sessions.filter((item) => item.repoId === repository.id)) : [];

  const openRun = (id: string, carriedNotice: string | null = null) => {
    setNotice(carriedNotice);
    setDetail(null);
    setView({ kind: 'run', runId: id });
  };
  const openAgent = (id: string) => {
    setNotice(null);
    setDetail(null);
    setView({ kind: 'session', sessionId: id });
  };
  const backToRepository = () => {
    const id = repository?.id ?? detail?.repository.id ?? repos[0]?.id;
    setDetail(null);
    setView(id ? { kind: 'repository', repositoryId: id } : null);
  };

  return (
    <section className="mobile-workspace">
      <header className="mobile-topbar">
        {view?.kind === 'run' || view?.kind === 'session'
          ? <button aria-label="Back to repository" className="mobile-icon-button" onClick={backToRepository} type="button">‹</button>
          : <button aria-label="Open repositories" className="mobile-icon-button" onClick={() => setDrawerOpen(true)} type="button"><MenuIcon /></button>}
        <span className="mobile-topbar-copy">
          <strong>
            {view?.kind === 'run' ? (detail?.objective ?? 'Run')
              : view?.kind === 'session' ? (openSession ? agentLabel(openSession) : 'Agent')
                : (repository?.name ?? 'AgentDeck')}
          </strong>
          <small>
            {view?.kind === 'run' && detail
              ? <><span className={`mobile-run-dot status-${detail.status}`} />{formatRunLabel(detail.status)}</>
              : view?.kind === 'session' && openSession
                ? <><span className={`mobile-status-dot status-${openSession.status}`} />{STATUS_LABELS[openSession.status]}</>
                : `Signed in as ${principal.displayName}`}
          </small>
        </span>
        {onSignOut && view?.kind !== 'run' && view?.kind !== 'session'
          ? <button className="mobile-signout" onClick={onSignOut} type="button">Sign out</button>
          : <span aria-hidden="true" className="mobile-topbar-spacer" />}
      </header>

      {notice && <p className="mobile-run-blocked-banner" role="status">{notice}</p>}

      {view?.kind === 'run' && detail && (
        <RunConversation detail={detail} onResolveRunAttention={onResolveRunAttention} />
      )}
      {view?.kind === 'run' && !detail && <main className="mobile-workspace-empty"><span>Loading this Run…</span></main>}

      {view?.kind === 'session' && openSession && (
        <>
          <AgentConversation loading={!messagesLoaded} messages={messages} session={openSession} />
          <AgentComposer
            capabilities={capabilities}
            onError={onError}
            onSent={() => { setMessagesLoaded(false); }}
            sessionId={openSession.id}
          />
        </>
      )}
      {view?.kind === 'session' && !openSession && (
        <main className="mobile-workspace-empty">
          <strong>This agent is no longer listed</strong>
          <span>It may have finished, or your access to its Repository may have changed.</span>
        </main>
      )}

      {view?.kind === 'repository' && repository && (
        <>
          <main aria-label="Work in this repository" className="mobile-run-list">
            {repositorySessions.length > 0 && (
              <>
                <h2 className="mobile-run-list-heading">Agents</h2>
                {repositorySessions.map((item) => (
                  <AgentTile key={item.id} onSelect={() => openAgent(item.id)} session={item} />
                ))}
              </>
            )}
            <h2 className="mobile-run-list-heading">Runs</h2>
            {repositoryRuns.map((run) => <RunTile key={run.id} onSelect={() => openRun(run.id)} run={run} />)}
            {repositoryRuns.length === 0 && (
              <p className="mobile-run-list-empty">No work has been requested in {repository.name} yet. Ask for some below.</p>
            )}
          </main>
          <RequestWorkComposer
            onError={onError}
            onRequested={(newRunId, note) => { onRunsStale(); openRun(newRunId, note ?? null); }}
            profiles={profiles}
            repository={repository}
          />
        </>
      )}

      {!repository && view?.kind !== 'run' && view?.kind !== 'session' && (
        <main className="mobile-workspace-empty">
          <strong>Nothing granted yet</strong>
          <span>No Repositories have been granted to you. Ask the admin for access.</span>
        </main>
      )}

      <RepositoryDrawer
        onClose={() => setDrawerOpen(false)}
        onSelect={(repositoryId) => { setDetail(null); setView({ kind: 'repository', repositoryId }); }}
        open={drawerOpen}
        repos={repos}
        runs={runs}
        selectedId={repository?.id ?? null}
        sessions={sessions}
      />
    </section>
  );
}
