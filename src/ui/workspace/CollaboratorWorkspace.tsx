// The Collaborator workspace: one repo-scoped place to see what work has been
// done, follow what is running, and ask for more.
//
// Before this, a Collaborator's phone rendered MobileWorkspace's session tree
// — which is built entirely around Sessions they cannot reach (app.ts refuses
// them GET /api/sessions, and ws.ts refuses them 'attach'), so the drawer was
// permanently empty — plus a '+' button whose Run went to 'queued' and stayed
// there. Three disconnected things, none of which worked end to end.
//
// So this is deliberately NOT a session view with Runs bolted on. Repository
// pages remain the grant-scoped home for work and their request composer. A
// small cross-Repository "Your requests" list sits beside those pages and
// hands off to the same authorized Run detail; its membership is the server's
// Principal-derived isRequestedByMe value, never display-name comparison.
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
//
// Presentation adopts the admin desktop shell (parent issue #37's
// docs/specs/agentdeck-ui-redesign-scope.md, A01/A02/A03/A05/A06/A07/A09/A10/
// A16): the same sidebar, topbar, .operation-group card lists and
// .run-workspace detail page the admin desktop uses, rather than the phone
// layout this surface was born with. Every handler, poll, and derived list
// below is unchanged from before that pass — only the returned JSX and class
// names differ. CollaboratorSidebar.tsx replaces the old off-canvas-only
// RepositoryDrawer; RequestWorkModal.tsx replaces the composer that used to
// be pinned to the bottom of a Repository's feed.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  CollaboratorSession, Repo, SessionStatus,
} from '../../types.js';
import type {
  AttentionDecisionInput, CollaboratorRunDetail, CollaboratorRunSummary, Profile, RunStatus,
} from '../../work-engine/types.js';
import { describeOutcome, formatTokenCount } from '../../work-engine/attempt-narrative.js';
import {
  CollaboratorRunReadError, getCollaboratorRun, type CollaboratorListState,
} from '../collaboratorRuns.js';
import { RequestWorkModal } from '../components/RequestWorkModal.js';
import { RunFeedbackPanel } from './RunFeedbackPanel.js';
import { SessionChat } from './SessionChat.js';
import { CollaboratorSidebar } from './CollaboratorSidebar.js';
import { SESSION_STATUS_OPTIONS, STATUS_LABELS, StatusBadge, StatusLamp, narrativeStepTime, relativeTime } from './model.js';
import { CommandPalette } from './CommandPalette.js';
import { formatRunLabel, isTerminalRunStatus, RUN_STATUS_OPTIONS } from './runModel.js';

export interface Props {
  /** Supplied by App so this surface reuses the desktop appearance picker and its existing behavior. */
  appearanceControl?: ReactNode;
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
  runListState?: CollaboratorListState;
  repositoryListState?: CollaboratorListState;
  /** Drops this device's credential and returns to the gate. Optional so existing callers/tests need no change. */
  onSignOut?: () => void;
}

type RunReturnTarget = { kind: 'repository'; repositoryId: string } | { kind: 'requests' };

type View =
  | RunReturnTarget
  | { kind: 'run'; runId: string; returnTo: RunReturnTarget }
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

/** This Session's runtime, as a reader-facing label — the server names an agent's own chat turns the same way (session-conversation.ts's agentDisplayName), so a message from "the agent" always reads the same here as there. */
function runtimeLabel(session: CollaboratorSession): string {
  return session.agent === 'claude' ? 'Claude Code' : 'Codex';
}

/** A Session's name if it has one — never sessionLabel(), which derives its fallback from `cwd`, a field this projection deliberately does not carry. */
function agentLabel(session: CollaboratorSession): string {
  return session.name ?? runtimeLabel(session);
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

/** A Run row in a Repository's feed or "Your requests" — the admin desktop's .overview-row shape (OverviewView.tsx's own RunRow), reused rather than re-invented so the two surfaces read as one family. */
function RunRow({ run, onSelect, showRepository = false }: { run: CollaboratorRunSummary; onSelect: () => void; showRepository?: boolean }) {
  const terminal = isTerminalRunStatus(run.status);
  return (
    <button
      className={`overview-row overview-run-row collab-row${terminal ? ' is-terminal' : ''}`}
      data-run-id={run.id}
      onClick={onSelect}
      type="button"
    >
      <span aria-hidden="true" className="overview-row-glyph overview-run-glyph">RUN</span>
      <span className="overview-row-content">
        <strong className="collab-row-objective" title={run.objective}>{run.objective}</strong>
        <small>{showRepository ? run.repository.name : run.requestedBy} · {relativeTime(run.submittedAt)}</small>
        {run.preparation.note && <small className="collab-row-blocked">{run.preparation.note}</small>}
      </span>
      {run.pendingAttentionKind && (
        <span className="overview-row-attention">
          {showRepository
            ? (run.pendingAttentionKind === 'approval' ? 'Repository approval pending' : 'Repository input pending')
            : (run.pendingAttentionKind === 'approval' ? 'Needs your approval' : 'Needs your input')}
        </span>
      )}
      <span className={`work-run-status status-${run.status}`}>{formatRunLabel(run.status)}</span>
    </button>
  );
}

/** An agent running in this Repository. Deliberately the same row shape as RunRow so the two read as one feed rather than two lists that happen to sit together — mirrors the admin desktop's own SessionRow (OverviewView.tsx). */
function AgentRow({ session, onSelect }: { session: CollaboratorSession; onSelect: () => void }) {
  const ended = session.status === 'exited';
  return (
    <button
      className={`overview-row overview-session-row collab-row${ended ? ' is-terminal' : ''}`}
      data-session-id={session.id}
      onClick={onSelect}
      type="button"
    >
      <StatusLamp pulse={session.status === 'working'} status={session.status} />
      <span className="overview-row-content">
        <strong>{agentLabel(session)}</strong>
        <small>{runtimeLabel(session)} · {relativeTime(session.lastActivityAt)}</small>
      </span>
      {session.status === 'waiting_input' && <span className="overview-row-attention">Waiting for a reply</span>}
      <StatusBadge status={session.status} />
    </button>
  );
}

/** Ticket 07's input-kind reply, inline in the Run conversation — same shape as the admin desktop's own AttentionInputForm (RunWorkspace.tsx). */
function RunAttentionReply({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="run-attention-input-form"
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

/**
 * Ticket 44 (A10): verification verdicts and authorized decisions are the
 * outcome a Collaborator came here to read, so they stay directly visible.
 * Commit identity and the changed-file list are secondary/technical — real
 * detail, never hidden, but tucked behind a disclosure rather than
 * competing with the verdict for attention. Reuses the admin desktop's own
 * .run-intent-grid/.run-result-verification/.run-technical-detail shapes
 * (RunWorkspace.tsx's own RunResultPanel) rather than a parallel set.
 */
function RunResultPanel({ result }: { result: NonNullable<CollaboratorRunDetail['result']> }) {
  const hasTechnicalDetail = Boolean(result.commit) || result.changedFiles.length > 0;
  return (
    <section className="run-result">
      <h3>Result</h3>
      {result.recoveryNotes && <p className="collab-run-result-note">{result.recoveryNotes}</p>}
      {(result.verification.length > 0 || result.approvals.length > 0) && (
        <dl className="run-intent-grid">
          {result.verification.length > 0 && (
            <div>
              <dt>Verification</dt>
              <dd>
                <ul className="run-result-verification">
                  {result.verification.map((gate) => (
                    <li className={gate.passed ? 'is-success' : 'is-failure'} key={gate.gate}>
                      {gate.passed ? '✓' : '✕'} {gate.gate}{gate.required ? '' : ' (optional)'}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {result.approvals.length > 0 && (
            <div>
              <dt>Decisions</dt>
              <dd>{result.approvals.map((approval) => (
                <span key={approval.attentionId}>{formatRunLabel(approval.decision)}: {approval.reason}</span>
              ))}</dd>
            </div>
          )}
        </dl>
      )}
      {hasTechnicalDetail && (
        <details className="run-technical-detail">
          <summary>Commit &amp; files</summary>
          {result.commit && (
            <p className="collab-run-result-commit">
              Committed <code>{result.commit.sha.slice(0, 12)}</code> on {result.commit.branch}
              {result.commit.signed ? ' · signed' : ''}
            </p>
          )}
          {result.changedFiles.length > 0 && (
            <ul className="collab-run-files">
              {result.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}

/**
 * Presentation-only redesign slice (parent issue #37,
 * docs/prototypes/agentdeck-redesign.html): a calmer default view for a
 * Run that used to be one long scroll of narrative, result and feedback.
 * Every panel below stays mounted regardless of which tab is active — only
 * the `hidden` attribute changes — so a feedback draft or the objective/
 * status/Attention/failure banner above never unmounts or loses state on a
 * tab switch. Only opening a *different* Run resets the selection, via the
 * detail.id effect below. Same WAI-ARIA "Tabs" pattern, and deliberately a
 * separate implementation, as the admin desktop's RunDetailTabList
 * (RunWorkspace.tsx) — that component's own comment already explains why
 * the two surfaces' tabs are kept independent rather than shared. Reuses the
 * admin's own .run-detail-tabs styling so the two look identical.
 */
type RunDetailTab = 'overview' | 'updates';
const RUN_DETAIL_TABS: { id: RunDetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'updates', label: 'Updates' },
];

/** WAI-ARIA "Tabs" pattern: roving tabindex, Left/Right/Home/End move both selection and focus. */
function RunDetailTabList({ active, onChange }: { active: RunDetailTab; onChange: (tab: RunDetailTab) => void }) {
  const buttonRefs = useRef<Partial<Record<RunDetailTab, HTMLButtonElement | null>>>({});
  const select = (id: RunDetailTab) => {
    onChange(id);
    buttonRefs.current[id]?.focus();
  };
  return (
    <div
      aria-label="Run detail sections"
      className="run-detail-tabs"
      onKeyDown={(event) => {
        const index = RUN_DETAIL_TABS.findIndex((tab) => tab.id === active);
        if (event.key === 'ArrowRight') { event.preventDefault(); select(RUN_DETAIL_TABS[(index + 1) % RUN_DETAIL_TABS.length]!.id); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); select(RUN_DETAIL_TABS[(index - 1 + RUN_DETAIL_TABS.length) % RUN_DETAIL_TABS.length]!.id); }
        else if (event.key === 'Home') { event.preventDefault(); select(RUN_DETAIL_TABS[0]!.id); }
        else if (event.key === 'End') { event.preventDefault(); select(RUN_DETAIL_TABS.at(-1)!.id); }
      }}
      role="tablist"
    >
      {RUN_DETAIL_TABS.map((tab) => (
        <button
          aria-controls={`mobile-run-tabpanel-${tab.id}`}
          aria-selected={active === tab.id}
          className={active === tab.id ? 'is-active' : ''}
          id={`mobile-run-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          ref={(el) => { buttonRefs.current[tab.id] = el; }}
          role="tab"
          tabIndex={active === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A plain-language headline for every RunStatus a Collaborator can actually do nothing about but read — never for 'cancelled', which was an intentional stop, not a failure. */
const FAILURE_HEADLINES: Partial<Record<RunStatus, string>> = {
  failed: 'This Run did not finish',
  failed_verification: 'Verification did not pass',
  failed_budget: 'This Run stopped at its budget limit',
};

/**
 * An actionable failure explanation, kept visible above the tabs — never
 * gated behind the "Updates" tab a reader would otherwise have to find
 * first. `result.recoveryNotes` (the same precise reason RunResultPanel's
 * own "Result" section shows in Overview) is preferred over the
 * narrative's generic verdict text, since it also covers verification and
 * budget failures the narrative log never turns into a `failure` event
 * (attempt-narrative.ts's summarizeAttempt only recognizes an explicit
 * `failure` event, never `verification-outcome`).
 */
function RunFailureNotice({ detail }: { detail: CollaboratorRunDetail }) {
  const headline = FAILURE_HEADLINES[detail.status];
  if (!headline) return null;
  const reason = detail.result?.recoveryNotes ?? describeOutcome(detail.narrative.outcome);
  return (
    <div className="run-blocked-notice" role="alert">
      <strong>{headline}</strong>
      {reason && <p>{reason}</p>}
    </div>
  );
}

function RunConversation({ detail, onResolveRunAttention }: {
  detail: CollaboratorRunDetail;
  onResolveRunAttention: (runId: string, attentionId: string, decision: AttentionDecisionInput) => void;
}) {
  const { narrative, pendingAttention } = detail;
  const verdict = describeOutcome(narrative.outcome);
  const [activeTab, setActiveTab] = useState<RunDetailTab>('overview');
  // Default to Overview whenever a *different* Run is opened — never on a
  // same-Run re-render (a poll refresh), which would otherwise yank the
  // reader back out of whatever tab they were reading. Same guard shape as
  // the admin desktop's RunWorkspace.
  const runIdRef = useRef(detail.id);
  useEffect(() => {
    if (runIdRef.current !== detail.id) {
      runIdRef.current = detail.id;
      setActiveTab('overview');
    }
  }, [detail.id]);

  // Ticket 70 (B10)'s own design doc
  // (docs/specs/run-result-application-previews.md) is explicit that a live
  // preview control is not authorized for this surface: the preview
  // listener binds 127.0.0.1 only, which on a remote collaborator's own
  // device names their own machine, never the admin's — a control here
  // could never actually open. This is eligibility only (which file, if
  // any, would qualify), never a broken "Open preview" action.
  const previewCandidates = (detail.result?.changedFiles ?? []).filter((path) => path.endsWith('.html'));

  return (
    <article className="run-workspace collab-run-detail">
      <header>
        <span><small>Run {detail.id}</small><h1 title={detail.objective}>{detail.objective}</h1></span>
        <span className="run-header-actions">
          <span className={`work-run-status status-${detail.status}`}>{formatRunLabel(detail.status)}</span>
        </span>
      </header>
      <small className="collab-run-meta">Requested by {detail.requestedBy} · {relativeTime(detail.submittedAt)} · base {detail.requestedBaseReference}</small>

      {detail.preparation.note && <p className="collab-inline-notice" role="status">{detail.preparation.note}</p>}
      <RunFailureNotice detail={detail} />

      {pendingAttention && (
        <section aria-labelledby="run-attention-title" className="run-attention-request" data-attention-kind={pendingAttention.kind}>
          <strong id="run-attention-title">
            {pendingAttention.kind === 'approval' ? 'Approval needed' : 'Input needed'}
          </strong>
          <p>{pendingAttention.reason}</p>
          {pendingAttention.kind === 'approval' ? (
            <div aria-label="Run approval response" className="run-attention-actions" role="group">
              <button className="button" onClick={() => onResolveRunAttention(detail.id, pendingAttention.id, { kind: 'deny' })} type="button">
                Deny
              </button>
              <button
                className="button button-primary"
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

      <RunDetailTabList active={activeTab} onChange={setActiveTab} />

      <div aria-labelledby="mobile-run-tab-overview" className="run-detail-panel" hidden={activeTab !== 'overview'} id="mobile-run-tabpanel-overview" role="tabpanel">
        <section><h2>Acceptance criteria</h2><ol>{detail.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol></section>

        {detail.result && <RunResultPanel result={detail.result} />}

        {previewCandidates.length > 0 && (
          <p className="collab-run-preview-note">
            This result includes an application preview file — <code>{previewCandidates.join(', ')}</code>. Opening a live preview isn’t available on this device yet.
          </p>
        )}

        <RunFeedbackPanel headingLevel="h3" runId={detail.id} />
      </div>

      <div aria-labelledby="mobile-run-tab-updates" className="run-detail-panel" hidden={activeTab !== 'updates'} id="mobile-run-tabpanel-updates" role="tabpanel">
        {narrative.answer && (
          <section className="run-attempt-answer">
            <h3>What it found</h3>
            <p>{narrative.answer}</p>
          </section>
        )}

        {narrative.steps.length > 0 && (
          <section className="run-attempt-steps">
            <div className="run-attempt-steps-header">
              <h3>What it did</h3>
              {narrative.stepsTruncated && <small className="collab-run-truncated">Showing the most recent steps.</small>}
            </div>
            <ol className="run-attempt-activity">
              {narrative.steps.map((step) => {
                const time = narrativeStepTime(step.at);
                return (
                  <li className={`run-attempt-step status-${step.status}`} key={step.sequence}>
                    <span aria-hidden="true" className="run-step-mark">{STATUS_MARK[step.status]}</span>
                    <span className="run-step-label">
                      {step.label}
                      {time && (
                        <time className="run-step-time" dateTime={time.iso} title={time.title}> · {time.label}</time>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {verdict && (
          <p className={`run-attempt-verdict ${narrative.outcome?.kind === 'failure' ? 'is-failure' : 'is-success'}`}>
            {verdict}
            {narrative.usage && (narrative.usage.inputTokens !== 'unknown' || narrative.usage.outputTokens !== 'unknown') && (
              <span> · {formatTokenCount(narrative.usage.inputTokens)} in / {formatTokenCount(narrative.usage.outputTokens)} out</span>
            )}
          </p>
        )}

        {narrative.steps.length === 0 && !narrative.answer && !detail.preparation.note && (
          <p className="collab-run-waiting">
            {detail.attemptState === 'idle' ? 'Getting a workspace ready…' : 'Working…'}
          </p>
        )}
      </div>
    </article>
  );
}

export function CollaboratorWorkspace({
  appearanceControl, principal, repos, profiles, runs, sessions, onError, onRunsStale, onResolveRunAttention, onSignOut,
  runListState = 'ready', repositoryListState = 'ready',
}: Props) {
  const [view, setView] = useState<View | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [runStatus, setRunStatus] = useState<'all' | RunStatus>('all');
  const [sessionStatus, setSessionStatus] = useState<'all' | SessionStatus>('all');
  const [detail, setDetail] = useState<CollaboratorRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRequestedRunRef = useRef<{ runId: string; beforeRefresh: readonly CollaboratorRunSummary[] } | null>(null);

  // Land on the first granted Repository rather than an empty screen — with
  // one Repository granted (the common case) there is nothing to choose.
  useEffect(() => {
    if (view === null && repos[0]) setView({ kind: 'repository', repositoryId: repos[0].id });
  }, [repos, view]);

  // ⌘K opens the same search this surface already renders — App.tsx's own
  // ⌘K listener only exists in the admin desktop tree, which never mounts
  // here, so this workspace needs its own.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if (event.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  const runId = view?.kind === 'run' ? view.runId : null;
  const detailRef = useRef<string | null>(null);
  useEffect(() => {
    detailRef.current = runId;
    setDetailError(null);
    if (!runId) setDetail(null);
  }, [runId]);

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
        setDetailError(null);
        if (!isTerminalRunStatus(next.status)) timer = setTimeout(() => { void tick(); }, 2000);
      } catch (error) {
        if (disposed) return;
        if (error instanceof CollaboratorRunReadError && (error.status === 403 || error.status === 404)) {
          setDetail(null);
          setDetailError('This Run is no longer available. Your Repository access may have changed.');
          return;
        }
        setDetailError('AgentDeck could not load this Run. Retrying…');
        timer = setTimeout(() => { void tick(); }, 5000);
      }
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId]);

  const sessionId = view?.kind === 'session' ? view.sessionId : null;
  const openSession = sessions.find((item) => item.id === sessionId) ?? null;

  // The list projections are the live authorization boundary. If either an
  // item or its Repository disappears, discard any cached detail immediately
  // rather than waiting for a rejected detail poll to retry indefinitely.
  useEffect(() => {
    const run = view?.kind === 'run' ? runs.find((item) => item.id === view.runId) : undefined;
    const session = view?.kind === 'session' ? sessions.find((item) => item.id === view.sessionId) : undefined;
    if (run && pendingRequestedRunRef.current?.runId === run.id) pendingRequestedRunRef.current = null;
    const awaitingFirstListRefresh = view?.kind === 'run'
      && pendingRequestedRunRef.current?.runId === view.runId
      && pendingRequestedRunRef.current.beforeRefresh === runs;
    const runAuthorized = run && repos.some((repo) => repo.id === run.repository.id);
    const sessionAuthorized = session && repos.some((repo) => repo.id === session.repoId);
    if ((view?.kind === 'run' && !runAuthorized && !awaitingFirstListRefresh) || (view?.kind === 'session' && !sessionAuthorized)) {
      pendingRequestedRunRef.current = null;
      setDetail(null);
      setNotice(null);
      const returnTo = view?.kind === 'run' ? view.returnTo : undefined;
      setView(returnTo?.kind === 'requests' ? returnTo : (repos[0] ? { kind: 'repository', repositoryId: repos[0].id } : null));
    }
  }, [repos, runs, sessions, view]);

  const repository = repos.find((repo) => repo.id === (
    view?.kind === 'repository' ? view.repositoryId
      : view?.kind === 'session' ? openSession?.repoId
        : detail?.repository.id
  ));
  const grantedRepositoryIds = new Set(repos.map((repo) => repo.id));
  const accessibleRuns = runs.filter((run) => grantedRepositoryIds.has(run.repository.id));
  const repositoryRuns = repository ? orderRuns(accessibleRuns.filter((run) => run.repository.id === repository.id)) : [];
  const repositorySessions = repository ? orderSessions(sessions.filter((item) => item.repoId === repository.id)) : [];
  const visibleRuns = runStatus === 'all' ? repositoryRuns : repositoryRuns.filter((run) => run.status === runStatus);
  const visibleSessions = sessionStatus === 'all' ? repositorySessions : repositorySessions.filter((session) => session.status === sessionStatus);
  const personalRuns = orderRuns(accessibleRuns.filter((run) => run.isRequestedByMe));
  const visiblePersonalRuns = runStatus === 'all' ? personalRuns : personalRuns.filter((run) => run.status === runStatus);

  const openRun = (
    id: string,
    carriedNotice: string | null = null,
    returnTo: RunReturnTarget = view?.kind === 'requests'
      ? { kind: 'requests' }
      : { kind: 'repository', repositoryId: repository?.id ?? runs.find((run) => run.id === id)?.repository.id ?? repos[0]?.id ?? '' },
  ) => {
    setNotice(carriedNotice);
    setDetail(null);
    setDetailError(null);
    setView({ kind: 'run', runId: id, returnTo });
  };
  const openAgent = (id: string) => {
    setNotice(null);
    setDetail(null);
    setView({ kind: 'session', sessionId: id });
  };
  const backToRepository = () => {
    if (view?.kind === 'run' && view.returnTo.kind === 'requests') {
      setDetail(null);
      setView(view.returnTo);
      return;
    }
    const id = repository?.id ?? detail?.repository.id ?? repos[0]?.id;
    setDetail(null);
    setView(id ? { kind: 'repository', repositoryId: id } : null);
  };

  const contextEyebrow = view?.kind === 'run' ? 'Run' : view?.kind === 'session' ? 'Agent' : view?.kind === 'requests' ? 'Work' : 'Repository';
  const contextTitle = view?.kind === 'run' ? (detail?.objective ?? 'Run')
    : view?.kind === 'session' ? (openSession ? agentLabel(openSession) : 'Agent')
      : view?.kind === 'requests' ? 'Your requests'
        : (repository?.name ?? 'AgentDeck');
  const backTarget = view?.kind === 'run' ? view.returnTo : null;
  const backLabel = backTarget?.kind === 'requests' ? 'Your requests' : (repos.find((repo) => repo.id === backTarget?.repositoryId)?.name ?? repository?.name ?? 'Repository');

  return (
    <div className="admin-shell-main">
      <CollaboratorSidebar
        canRequestWork={Boolean(repository)}
        onNewRequest={() => setRequestOpen(true)}
        onSelectRepository={(repositoryId) => { setDetail(null); setDrawerOpen(false); setView({ kind: 'repository', repositoryId }); }}
        onSelectRequests={() => { setDetail(null); setNotice(null); setDrawerOpen(false); setView({ kind: 'requests' }); }}
        onSelectRun={(id) => { setDrawerOpen(false); openRun(id); }}
        onSelectSession={(id) => { setDrawerOpen(false); openAgent(id); }}
        open={drawerOpen}
        repos={repos}
        requestsSelected={view?.kind === 'requests'}
        runs={accessibleRuns}
        selectedRepositoryId={repository?.id ?? null}
        sessions={sessions}
      />
      <div className="admin-shell-content">
        <header className="app-topbar">
          <button aria-label="Open repositories" className="collab-menu-button" onClick={() => setDrawerOpen(true)} type="button"><MenuIcon /></button>
          <div className="topbar-context"><span>{contextEyebrow}</span><strong title={contextTitle}>{contextTitle}</strong></div>
          <button aria-label="Search accessible work" className="jump-control" onClick={() => setSearchOpen(true)} type="button">
            <span>⌕</span><strong>Search repositories, runs, or agents…</strong><kbd>⌘K</kbd>
          </button>
          <div className="topbar-actions">
            {appearanceControl}
            <span className="collab-signed-in">Signed in as {principal.displayName}</span>
            <button
              className="button compact-button button-primary"
              disabled={!repository}
              onClick={() => setRequestOpen(true)}
              title={repository ? undefined : 'Open a Repository to request work'}
              type="button"
            >
              ＋ New request
            </button>
            {onSignOut && <button className="button compact-button" onClick={onSignOut} type="button">Sign out</button>}
          </div>
        </header>

        {notice && (
          <div className="global-banner" role="status">
            <span>{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice(null)} type="button">×</button>
          </div>
        )}

        <main className="workspace-stage collab-stage">
          {view?.kind === 'run' && detail && (
            <div className="collab-detail-scroll">
              <button aria-label={backTarget?.kind === 'requests' ? 'Back to your requests' : 'Back to repository'} className="repository-page-back" onClick={backToRepository} type="button">‹ {backLabel}</button>
              <RunConversation detail={detail} onResolveRunAttention={onResolveRunAttention} />
            </div>
          )}
          {view?.kind === 'run' && !detail && (
            <div className="empty-workspace">
              {detailError ? <><strong>Run unavailable</strong><span role="status">{detailError}</span></> : <span>Loading this Run…</span>}
            </div>
          )}

          {view?.kind === 'session' && openSession && (
            <div className="collab-detail-scroll">
              <button aria-label="Back to repository" className="repository-page-back" onClick={backToRepository} type="button">‹ {repository?.name ?? 'Repository'}</button>
              <SessionChat key={openSession.id} session={openSession} principal={principal} onError={onError} />
            </div>
          )}
          {view?.kind === 'session' && !openSession && (
            <div className="empty-workspace">
              <strong>This agent is no longer listed</strong>
              <span>It may have finished, or your access to its Repository may have changed.</span>
            </div>
          )}

          {view?.kind === 'requests' && (
            <div className="workspace-scroll">
              <div className="view-heading">
                <h1>Your requests</h1>
                <span>{personalRuns.length} request{personalRuns.length === 1 ? '' : 's'} across your Repositories</span>
              </div>
              <section className="operation-group">
                <header className="operation-group-header">
                  <strong>Requests</strong><small>{visiblePersonalRuns.length} of {personalRuns.length}</small>
                  <select aria-label="Filter your requests by status" onChange={(event) => setRunStatus(event.target.value as 'all' | RunStatus)} value={runStatus}>
                    <option value="all">All statuses</option>
                    {RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{formatRunLabel(status)}</option>)}
                  </select>
                </header>
                {(runListState === 'loading' || repositoryListState === 'loading') && <div className="overview-empty-row">Loading your requests…</div>}
                {runListState === 'error' && <div className="overview-empty-row" role="status">AgentDeck could not refresh your requests. Showing the last available results.</div>}
                {repositoryListState === 'error' && <div className="overview-empty-row" role="status">AgentDeck could not refresh your Repository access. Showing the last available results.</div>}
                {visiblePersonalRuns.map((run) => <RunRow key={run.id} onSelect={() => openRun(run.id)} run={run} showRepository />)}
                {runListState === 'ready' && repositoryListState === 'ready' && personalRuns.length === 0 && (
                  <div className="overview-empty-row">
                    {repos.length === 0
                      ? 'No Repositories are currently granted to you, so no requests are available.'
                      : 'No requests are available in your granted Repositories.'}
                  </div>
                )}
                {personalRuns.length > 0 && visiblePersonalRuns.length === 0 && <div className="overview-empty-row">No requests match {formatRunLabel(runStatus)}.</div>}
              </section>
            </div>
          )}

          {view?.kind === 'repository' && repository && (
            <div className="workspace-scroll">
              <div className="view-heading">
                <h1>{repository.name}</h1>
                <span>⎇ {repository.currentBranch ?? 'unknown'} · {repositoryRuns.length} run{repositoryRuns.length === 1 ? '' : 's'} · {repositorySessions.length} agent{repositorySessions.length === 1 ? '' : 's'}</span>
              </div>

              {repositorySessions.length > 0 && (
                <section className="operation-group">
                  <header className="operation-group-header">
                    <strong>Agents</strong><small>{visibleSessions.length} of {repositorySessions.length}</small>
                    <select aria-label="Filter Sessions by status" onChange={(event) => setSessionStatus(event.target.value as 'all' | SessionStatus)} value={sessionStatus}>
                      <option value="all">All statuses</option>
                      {SESSION_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                    </select>
                  </header>
                  {visibleSessions.map((item) => <AgentRow key={item.id} onSelect={() => openAgent(item.id)} session={item} />)}
                  {visibleSessions.length === 0 && <div className="overview-empty-row">No agents match {sessionStatus === 'all' ? 'all statuses' : STATUS_LABELS[sessionStatus]}.</div>}
                </section>
              )}

              <section className="operation-group">
                <header className="operation-group-header">
                  <strong>Runs</strong><small>{visibleRuns.length} of {repositoryRuns.length}</small>
                  <select aria-label="Filter Runs by status" onChange={(event) => setRunStatus(event.target.value as 'all' | RunStatus)} value={runStatus}>
                    <option value="all">All statuses</option>
                    {RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{formatRunLabel(status)}</option>)}
                  </select>
                </header>
                {visibleRuns.map((run) => <RunRow key={run.id} onSelect={() => openRun(run.id)} run={run} />)}
                {repositoryRuns.length === 0 && (
                  <div className="overview-empty-row">No work has been requested in {repository.name} yet. Ask for some with “New request”.</div>
                )}
                {repositoryRuns.length > 0 && visibleRuns.length === 0 && <div className="overview-empty-row">No Runs match {formatRunLabel(runStatus)}.</div>}
              </section>
            </div>
          )}

          {!repository && view?.kind !== 'run' && view?.kind !== 'session' && view?.kind !== 'requests' && repositoryListState === 'loading' && (
            <div className="empty-workspace"><span>Loading your Repository access…</span></div>
          )}
          {!repository && view?.kind !== 'run' && view?.kind !== 'session' && view?.kind !== 'requests' && repositoryListState === 'error' && (
            <div className="empty-workspace"><strong>Repository access unavailable</strong><span>AgentDeck could not refresh your Repository access.</span></div>
          )}
          {!repository && view?.kind !== 'run' && view?.kind !== 'session' && view?.kind !== 'requests' && repositoryListState === 'ready' && (
            <div className="empty-workspace">
              <strong>Nothing granted yet</strong>
              <span>No Repositories have been granted to you. Ask the admin for access.</span>
            </div>
          )}
        </main>
      </div>

      {drawerOpen && (
        <button aria-label="Close repositories" className="collab-scrim" onClick={() => setDrawerOpen(false)} type="button" />
      )}

      <CommandPalette
        onClose={() => setSearchOpen(false)}
        onSelectRepo={(repo) => { setDetail(null); setNotice(null); setDrawerOpen(false); setView({ kind: 'repository', repositoryId: repo.id }); }}
        onSelectRun={(run) => openRun(run.id)}
        onSelectSession={(session) => openAgent(session.id)}
        open={searchOpen}
        repos={repos}
        runs={accessibleRuns}
        sessions={sessions}
      />

      {requestOpen && repository && (
        <RequestWorkModal
          onClose={() => setRequestOpen(false)}
          onError={onError}
          onRequested={(newRunId, note) => {
            pendingRequestedRunRef.current = { runId: newRunId, beforeRefresh: runs };
            onRunsStale();
            setRequestOpen(false);
            openRun(newRunId, note ?? null);
          }}
          profiles={profiles}
          repository={repository}
        />
      )}
    </div>
  );
}
