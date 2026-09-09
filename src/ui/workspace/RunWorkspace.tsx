import { useState } from 'react';
import { derivePreviewCandidates } from '../../work-engine/run-preview.js';
import { deriveRunResult } from '../../work-engine/run-result.js';
import { defaultPublicationTarget } from '../../work-engine/publication.js';
import type { RunCompanionSessionRef } from '../../work-engine/run-companion-session.js';
import type {
  AttemptEvent, AttentionDecisionInput, PublicationTarget, RunPublication, WorkRun,
} from '../../work-engine/types.js';
import {
  describeOutcome, formatTokenCount, summarizeAttempt, type ActivityStatus,
} from './attemptActivity.js';
import { HistoryScrollback } from './HistoryView.js';
import { RunFeedbackPanel } from './RunFeedbackPanel.js';
import { formatRunLabel, isRetryAttemptEligibleStatus, isTerminalRunStatus } from './runModel.js';

/** The heading + status pill shared by most collapsible run-section-detail summaries below — a section with one Run-level state, not a list of independently-stated rows (see CompanionSessionsPanel, which has no single state to show a pill for). */
function SectionSummary({ heading, state }: { heading: string; state: string }) {
  return (
    <summary>
      <h2>{heading}</h2>
      <span className={`work-run-status status-${state}`}>{formatRunLabel(state)}</span>
    </summary>
  );
}

function describeAttemptEvent(event: AttemptEvent): { label: string; detail?: string } {
  switch (event.kind) {
    case 'lifecycle': return { label: formatRunLabel(event.phase) };
    case 'message': return { label: 'Assistant message', detail: event.text };
    case 'tool-activity': return { label: `${formatRunLabel(event.tool)} ${event.status}`, detail: event.summary };
    case 'usage': return { label: 'Usage', detail: `Input tokens: ${event.inputTokens} · Output tokens: ${event.outputTokens}` };
    case 'completion': return { label: `Completed — ${formatRunLabel(event.outcome)}`, detail: event.summary };
    case 'failure': return { label: 'Failed', detail: event.reason };
    case 'attention-requested': return { label: `${formatRunLabel(event.attentionKind)} requested`, detail: event.reason };
    case 'attention-resolved': return { label: formatRunLabel(event.decision), detail: event.input };
    case 'commit-created': return { label: `Committed ${event.sha.slice(0, 12)}`, detail: `${event.branch} · ${event.changedFiles.length} file(s)` };
    case 'commit-failed': return { label: 'Commit failed', detail: event.reason };
    case 'worktree-changes': return { label: `${event.changedFiles.length} changed file(s) observed`, detail: event.changedFiles.join(', ') };
    case 'delivery-outcome': return {
      label: `Delivery ${event.outcome}`,
      detail: event.reason ?? (event.repositoryPath && event.branch ? `${event.repositoryPath} · ${event.branch}` : undefined),
    };
    default: return { label: String(event) };
  }
}

/** Ticket 07: the input-kind attention response — pulled out so its own text-field state doesn't force RunWorkspace itself to be stateful. */
function AttentionInputForm({ onSubmit }: { onSubmit: (value: string) => void }) {
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
      <button className="button button-primary" disabled={!value.trim()} type="submit">Send</button>
    </form>
  );
}

const STATUS_MARK: Record<ActivityStatus, string> = { started: '…', completed: '\u2713', failed: '\u2715' };

/**
 * What an Attempt produced, for someone who did not write the commands.
 *
 * The answer first (it is what was asked for), then what the Run did in plain
 * sentences, then a verdict. The exact commands stay one toggle away — the
 * durable log keeps them, and a reader who wants them is one click from them.
 */
function AttemptReport({ events }: { events: readonly AttemptEvent[] }) {
  const [showDetail, setShowDetail] = useState(false);
  const { answer, steps, outcome, usage } = summarizeAttempt(events);
  const settled = Boolean(outcome);
  const verdict = describeOutcome(outcome);
  return (
    <>
      <section className="run-attempt-answer">
        <h3>Result</h3>
        {answer
          ? <p>{answer}</p>
          : <p className="is-empty">{settled ? 'This Run produced no written answer.' : 'Working\u2026'}</p>}
      </section>
      {steps.length > 0 && (
        <section className="run-attempt-steps">
          <div className="run-attempt-steps-header">
            <h3>What it did</h3>
            <button className="button run-detail-toggle" onClick={() => setShowDetail((shown) => !shown)} type="button">
              {showDetail ? 'Hide technical detail' : 'Show technical detail'}
            </button>
          </div>
          <ol className="run-attempt-activity">
            {steps.map((step) => (
              <li className={`run-attempt-step status-${step.status}`} key={step.sequence}>
                <span aria-hidden="true" className="run-step-mark">{STATUS_MARK[step.status]}</span>
                <span className="run-step-label">{step.label}</span>
                {showDetail && step.detail && <code>{step.detail}</code>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {verdict && (
        <p className={`run-attempt-verdict ${outcome?.kind === 'failure' ? 'is-failure' : 'is-success'}`}>
          {verdict}
          {usage && (usage.inputTokens !== 'unknown' || usage.outputTokens !== 'unknown') && (
            <span> · {formatTokenCount(usage.inputTokens)} in / {formatTokenCount(usage.outputTokens)} out tokens</span>
          )}
        </p>
      )}
      {showDetail && (
        <ol className="run-attempt-activity run-attempt-raw">
          {events.map((event) => {
            const { label, detail } = describeAttemptEvent(event);
            return (
              <li className={`run-attempt-event kind-${event.kind}`} key={event.sequence}>
                <strong>{label}</strong>
                {detail && <p>{detail}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

const PUBLICATION_STATE_COPY: Record<RunPublication['state'], string> = {
  authorized: 'Authorized — not yet started.',
  executing: 'Publishing…',
  succeeded: 'Published.',
  failed: 'Publication did not happen. Fix the cause and publish again.',
  ambiguous: 'Publication outcome is unknown. Check origin before publishing again.',
};

/**
 * Ticket 13: publication is a separate, explicit step after a verified
 * result — never implied by the result itself. Shows what the admin
 * authorized and exactly what came of it (AC4), and offers the action only
 * while there is something to do: nothing yet authorized, or a prior attempt
 * that failed or ended ambiguous and needs the admin's decision (AC6).
 * Collaborators never reach this desktop panel; the mobile UI does not
 * render it, and the engine refuses them regardless (AC2).
 */
function PublicationPanel({ run, onPublish }: { run: WorkRun; onPublish?: (run: WorkRun, target: PublicationTarget) => void }) {
  const result = deriveRunResult(run);
  if (!result?.commit || run.status !== 'completed') return null;
  const { publication } = run;
  const requestedTarget: PublicationTarget = defaultPublicationTarget(run.spec.requestedDeliveryResult);
  const canPublish = Boolean(onPublish) && (!publication || publication.state === 'failed' || publication.state === 'ambiguous');
  const actionLabel = publication
    ? (publication.state === 'ambiguous' ? 'Reconcile and retry' : 'Retry publication')
    : requestedTarget === 'draft-pull-request' ? 'Push and open draft pull request' : 'Push branch';
  return (
    <section className="run-publication" data-publication-state={publication?.state ?? 'none'}>
      <h3>Publication</h3>
      {!publication && <p className="run-publication-note">This result stays local until you publish it. Nothing has been pushed.</p>}
      {publication && (
        <dl className="run-intent-grid">
          <div>
            <dt>State</dt>
            <dd>
              <span className={`work-run-status status-${publication.state}`}>{formatRunLabel(publication.state)}</span>
              <span>{PUBLICATION_STATE_COPY[publication.state]}</span>
            </dd>
          </div>
          <div><dt>Target</dt><dd>{formatRunLabel(publication.target)}</dd></div>
          <div><dt>Authorized by</dt><dd>{publication.authorizedBy.displayName}<small>{new Date(publication.authorizedAt).toLocaleString()}</small></dd></div>
          <div><dt>Commit</dt><dd><code>{publication.commit.slice(0, 12)}</code> on <code>{publication.branch}</code></dd></div>
          {publication.result && (
            <div>
              <dt>Remote</dt>
              <dd>
                <code>{publication.result.remote.name}</code>
                <small>{publication.result.remote.url}</small>
                {publication.result.pullRequest && (
                  <a href={publication.result.pullRequest.url} rel="noreferrer" target="_blank">
                    Draft pull request #{publication.result.pullRequest.number}
                  </a>
                )}
              </dd>
            </div>
          )}
          {publication.reason && <div><dt>Why</dt><dd>{publication.reason}</dd></div>}
          <div><dt>Executions</dt><dd>{publication.executions}</dd></div>
        </dl>
      )}
      {canPublish && (
        <button className="button button-primary" onClick={() => onPublish?.(run, publication?.target ?? requestedTarget)} type="button">
          {actionLabel}
        </button>
      )}
    </section>
  );
}

/**
 * Ticket 10 AC5: CONTEXT.md's "Run result", presented as a structured
 * summary — never a prompt to go read the raw event log (AttemptReport's
 * "Show technical detail" toggle already covers that, for anyone who wants
 * it). Renders once the Attempt has settled, whatever the outcome —
 * AC7's honest non-success result gets the same treatment as a verified one.
 */
function RunResultPanel({ run, onApply, onReverify, onViewChanges, onPreview }: {
  run: WorkRun;
  onApply?: (run: WorkRun) => void;
  onReverify?: (run: WorkRun) => void;
  onViewChanges?: (run: WorkRun) => void;
  /** Ticket 70 (B10): requests a preview session for one candidate file (App.tsx's previewRun → POST /api/runs/:id/preview, then opens the returned URL in a new tab — never an iframe). Absent hides every preview control entirely. */
  onPreview?: (run: WorkRun, path: string) => void;
}) {
  const result = deriveRunResult(run);
  if (!result) return null;
  const previewCandidates = derivePreviewCandidates(result);
  // A finished Run that asked to land in the Repository but did not is the
  // single most important thing on this screen: the work exists, it is safe on
  // its own branch, and it is waiting on the operator. Buried in a definition
  // list it read as nothing having happened at all.
  const undelivered = result.commit
    && run.spec.requestedDeliveryResult === 'apply-to-repository'
    && result.delivery?.outcome !== 'applied';
  return (
    <section className="run-result">
      <h3>Run result</h3>
      {undelivered && result.commit && (
        <div className="run-delivery-blocked">
          <strong>Not applied to {run.spec.repository.name}</strong>
          <p>{result.delivery?.reason ?? 'Delivery to the Repository checkout has not been attempted yet.'}</p>
          <p>
            The work is safe: commit <code>{result.commit.sha.slice(0, 12)}</code> on branch{' '}
            <code>{result.commit.branch}</code>. Resolve the above, then apply it.
          </p>
        </div>
      )}
      <dl className="run-intent-grid">
        <div><dt>Outcome</dt><dd><span className={`work-run-status status-${result.outcome}`}>{formatRunLabel(result.outcome)}</span></dd></div>
        <div>
          <dt>Changed files</dt>
          <dd>{result.changedFiles.length > 0 ? result.changedFiles.map((file) => <code key={file}>{file}</code>) : 'None'}</dd>
        </div>
        {result.commit && (
          <div>
            <dt>Commit</dt>
            <dd>
              <code>{result.commit.sha.slice(0, 12)}</code> on <code>{result.commit.branch}</code>
              {result.commit.signed && <span> · signed</span>}
            </dd>
          </div>
        )}
        {result.delivery && (
          <div>
            <dt>Repository delivery</dt>
            <dd>
              <span className={`work-run-status status-${result.delivery.outcome}`}>{formatRunLabel(result.delivery.outcome)}</span>
              {result.delivery.repositoryPath && <small>{result.delivery.repositoryPath}{result.delivery.branch ? ` · ${result.delivery.branch}` : ''}</small>}
              {result.delivery.reason && <span>{result.delivery.reason}</span>}
            </dd>
          </div>
        )}
        {result.verificationEvidence.length > 0 && (
          <div>
            <dt>Verification evidence</dt>
            <dd>
              <ul className="run-result-verification">
                {result.verificationEvidence.map((check) => (
                  <li className={check.passed ? 'is-success' : 'is-failure'} key={`${check.gate}-${check.sequence}`}>
                    {check.passed ? '✓' : '✕'} {check.gate}{check.required ? '' : ' (supplemental)'}
                    <code>{check.command}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {result.approvals.length > 0 && (
          <div>
            <dt>Approvals</dt>
            <dd>{result.approvals.map((approval) => (
              <span key={approval.attentionId}>{formatRunLabel(approval.decision)}: {approval.reason}</span>
            ))}</dd>
          </div>
        )}
        {result.usage && (
          <div>
            <dt>Usage</dt>
            <dd>{formatTokenCount(result.usage.inputTokens)} in / {formatTokenCount(result.usage.outputTokens)} out tokens</dd>
          </div>
        )}
        <div>
          <dt>Budget</dt>
          <dd>{Object.entries(result.budget).map(([name, value]) => <span key={name}>{formatRunLabel(name)}: {value}</span>)}</dd>
        </div>
        {result.recoveryNotes && <div><dt>Recovery notes</dt><dd>{result.recoveryNotes}</dd></div>}
      </dl>
      <div className="run-attention-actions">
        {result.changedFiles.length > 0 && onViewChanges && <button className="button" onClick={() => onViewChanges(run)} type="button">View changes</button>}
        {run.status === 'failed_verification' && onReverify && <button className="button button-primary" onClick={() => onReverify(run)} type="button">{run.verificationPolicy.state === 'missing' ? 'Recover result' : 'Retry verification'}</button>}
        {result.commit && result.delivery?.outcome !== 'applied' && onApply && <button className="button button-primary" onClick={() => onApply(run)} type="button">Apply to repository</button>}
        {onPreview && previewCandidates.map((candidate) => (
          <button className="button" key={candidate.path} onClick={() => onPreview(run, candidate.path)} type="button">
            Preview {candidate.path}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Ticket 68 (B13, docs/specs/run-execution-terminal-capabilities.md):
 * advisory, never a claim of process identity — a Session here only means
 * "currently open in this Run's worktree," never "this Run's own
 * terminal," since no structured Attempt has ever had an attachable one.
 * Absent entirely (renders nothing) when no Session matches, the ordinary
 * case for most Runs — never shown as an empty-state message.
 */
function CompanionSessionsPanel({ companionSessions, onOpenCompanionSession }: {
  companionSessions: readonly RunCompanionSessionRef[];
  onOpenCompanionSession?: (sessionId: string) => void;
}) {
  if (companionSessions.length === 0) return null;
  return (
    <section className="run-companion-sessions">
      <details className="run-section-detail">
        <summary>Sessions in this worktree ({companionSessions.length})</summary>
        <ul className="run-companion-session-list">
          {companionSessions.map((session) => (
            <li className={session.exactWorktreeMatch ? 'is-exact-match' : 'is-repository-match'} key={session.sessionId}>
              <span>{formatRunLabel(session.origin)} · {formatRunLabel(session.agent)}</span>
              {!session.exactWorktreeMatch && <small>Same Repository, different worktree</small>}
              {session.status === 'exited' ? (
                // Never a live attach for an ended process. HistoryScrollback
                // is embedded directly (its own known sessionId) rather than
                // routing through the History tab, whose own list only shows
                // Sessions aged out of the rail's grace period — a Session
                // that only just ended wouldn't be there yet.
                <details className="run-technical-detail">
                  <summary>Ended — view scrollback</summary>
                  <HistoryScrollback sessionId={session.sessionId} />
                </details>
              ) : (
                onOpenCompanionSession && <button className="button button-primary" onClick={() => onOpenCompanionSession(session.sessionId)} type="button">Open terminal</button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

interface Props {
  run: WorkRun;
  onPrepare?: (run: WorkRun) => void;
  onStart?: (run: WorkRun) => void;
  /** Ticket 68 (B12): starts a genuinely new Attempt (App.tsx's retryAttempt → POST /api/runs/:id/attempts) — distinct from onReverify/onApply below, which never rerun the agent. Offered only once the current attempt has settled and the Run's own status says there's something to recover; never for a completed Run. */
  onRetryAttempt?: (run: WorkRun) => void;
  /** Ticket 54 (B11): requests a pause at the engine's next safe boundary (App.tsx's guideRun → POST /api/runs/:id/pause). Offered only while a live Attempt is actually running, never merely "queued" or "verifying between rounds is possible in principle." */
  onPause?: (run: WorkRun) => void;
  /** Ticket 54 (B11): lets a paused or pause-requested Attempt proceed (App.tsx's guideRun → POST /api/runs/:id/resume). Offered for both pause_requested and paused — the engine allows resuming before the request has even taken effect. */
  onResume?: (run: WorkRun) => void;
  onApply?: (run: WorkRun) => void;
  onReverify?: (run: WorkRun) => void;
  onViewChanges?: (run: WorkRun) => void;
  /** Ticket 70 (B10): requests a preview session for one candidate file (App.tsx's previewRun → POST /api/runs/:id/preview, then opens the returned URL in a new tab). Absent hides every preview control entirely. */
  onPreview?: (run: WorkRun, path: string) => void;
  /** Ticket 07: routes an operator decision for run.pendingAttention through the one Work Engine policy path (App.tsx's resolveRunAttention → POST /api/runs/:id/attention/:attentionId/{approve,deny,input}). */
  onResolveAttention?: (run: WorkRun, attentionId: string, decision: AttentionDecisionInput) => void;
  /** Ticket 13: the admin's explicit publish authorization (App.tsx's publishRun → POST /api/runs/:id/publish). Absent means the action is not offered at all. */
  onPublish?: (run: WorkRun, target: PublicationTarget) => void;
  /** Permanently removes this Run from history (App.tsx's deleteRun → DELETE /api/runs/:id). Only offered once the Run has reached a terminal status — see isTerminalRunStatus. */
  onDelete?: (run: WorkRun) => void;
  /** Ticket 05: the structured Attempt panel is experimental and stays hidden until this feature gate is on. */
  structuredAttemptsEnabled?: boolean;
  /** Ticket 68 (B13): Sessions sharing this Run's prepared worktree, derived live by App.tsx's deriveRunCompanionSessions — never stored, never a claim of process identity. Empty (never undefined) while nothing has loaded, so the panel renders nothing rather than a false empty-state. */
  companionSessions?: readonly RunCompanionSessionRef[];
  /** Ticket 68 (B13): opens the existing terminal view for a live companion Session (App.tsx's openTerminal), reusing that path verbatim — never a new attach mechanism. */
  onOpenCompanionSession?: (sessionId: string) => void;
}

export function RunWorkspace({
  run, onPrepare, onStart, onRetryAttempt, onPause, onResume, onApply, onReverify, onViewChanges, onPreview, onResolveAttention, onPublish, onDelete,
  structuredAttemptsEnabled = false, companionSessions = [], onOpenCompanionSession,
}: Props) {
  const { preparation, envelope, attempt } = run;
  const canPrepare = (preparation.state === 'pending' || preparation.state === 'failed') && onPrepare;
  const canDelete = isTerminalRunStatus(run.status) && Boolean(onDelete);
  // Both Codex and Claude have a real runtimes/*.ts Attempt adapter wired
  // into the engine's default runtimeAdapters (engine.ts) — any other
  // runtime preference is refused managed status before an envelope is ever
  // built (buildRunEnvelope, envelope.ts), so 'ready' here always means a
  // Run this section can actually start.
  const eligibleForStructuredAttempt = preparation.state === 'ready' && envelope.state === 'ready';
  const canStart = structuredAttemptsEnabled && eligibleForStructuredAttempt && attempt.state === 'idle' && Boolean(onStart);
  // Ticket 54 (B11): mirrors DurableWorkEngine.pause()/resume()'s own
  // eligibility exactly (engine.ts) — both require only a live Attempt
  // (attempt.state === 'running'); the engine itself never additionally
  // requires run.status === 'running', so pause is offered through
  // 'verifying'/'waiting_approval'/'waiting_input' too (deriveRunStatus,
  // attempt-projection.ts, folds all of those from the same underlying
  // attempt.state === 'running'), not only the bare 'running' label. Pause
  // is withheld only once a request already landed (pause_requested or
  // paused), where Resume takes over instead. Computed from the current
  // run, never toggled locally, so a transition invalid on the server
  // never shows as available here.
  const live = attempt.state === 'running' && run.status !== 'pause_requested' && run.status !== 'paused';
  const canPause = structuredAttemptsEnabled && live && Boolean(onPause);
  const canResume = structuredAttemptsEnabled && attempt.state === 'running'
    && (run.status === 'pause_requested' || run.status === 'paused') && Boolean(onResume);
  // Ticket 68 (B12): offered once the current (latest) attempt has settled
  // and the Run's own status says there's something to recover — never
  // while an attempt is idle/running (the same live check `canPause`/
  // `canResume` already use), and never for 'completed' (publish() already
  // covers "do more with a successful result"). Named and rendered as its
  // own, separate control from "Retry verification" (RunResultPanel) —
  // never merged into one, since only this one actually reruns the agent.
  const canRetryAttempt = structuredAttemptsEnabled && isRetryAttemptEligibleStatus(run.status)
    && (attempt.state === 'failed' || attempt.state === 'completed') && Boolean(onRetryAttempt);
  return (
    <article className="run-workspace">
      <header>
        <span><small>Run {run.id}</small><h1 title={run.spec.objective}>{run.spec.objective}</h1></span>
        <span className="run-header-actions">
          <span className={`work-run-status status-${run.status}`}>{formatRunLabel(run.status)}</span>
          {canDelete && (
            <button
              className="button danger-button"
              onClick={() => {
                if (window.confirm(`Delete this Run permanently? "${run.spec.objective}" and its full history will be removed. This cannot be undone.`)) {
                  onDelete?.(run);
                }
              }}
              type="button"
            >
              Delete
            </button>
          )}
        </span>
      </header>
      <section><h2>Acceptance criteria</h2><ol>{run.spec.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol></section>
      <dl className="run-intent-grid">
        <div><dt>Repository</dt><dd>{run.spec.repository.name}<small>{run.spec.repository.path}</small></dd></div>
        <div><dt>Requested base</dt><dd>{run.spec.requestedBaseReference}</dd></div>
        <div><dt>Runtime preference</dt><dd>{run.spec.runtimePreference.join(' → ')}</dd></div>
        <div><dt>Requested result</dt><dd>{formatRunLabel(run.spec.requestedDeliveryResult)}</dd></div>
        <div><dt>Budget</dt><dd>{Object.entries(run.spec.budget).map(([name, value]) => <span key={name}>{formatRunLabel(name)}: {value}</span>)}</dd></div>
        <div><dt>Verification intent</dt><dd><strong>{run.spec.verificationIntent.required ? 'Required' : 'Optional'}</strong>{run.spec.verificationIntent.commands.map((command) => <code key={command}>{command}</code>)}</dd></div>
      </dl>
      <section className="run-preparation">
        {/* Open while there is something to do or explain (pending/in
            progress/failed); once the worktree is ready, the facts stay in
            the DOM but collapse behind the status pill in the summary —
            they were the point while setup was underway, not afterward. */}
        <details className="run-section-detail" open={preparation.state !== 'ready'}>
          <SectionSummary heading="Worktree preparation" state={preparation.state} />
          <dl className="run-intent-grid">
            <div><dt>Resolved base commit</dt><dd>{preparation.baseCommit ? <code>{preparation.baseCommit}</code> : 'Not yet resolved'}</dd></div>
            <div>
              <dt>Worktree</dt>
              <dd>
                {preparation.worktreePath ? <code>{preparation.worktreePath}</code> : 'Not yet created'}
                {/* The path lives under AgentDeck's data directory in $HOME, but the
                    worktree belongs to the selected Repository — say so, because the
                    bare path reads as though the Run ran in the wrong repository. */}
                <small>Git worktree of {run.spec.repository.name} · {run.spec.repository.path}</small>
              </dd>
            </div>
            {preparation.error && <div><dt>Last error</dt><dd>{preparation.error}</dd></div>}
          </dl>
          {canPrepare && (
            <button className="button button-primary" onClick={() => onPrepare(run)} type="button">
              {preparation.state === 'failed' ? 'Retry worktree preparation' : 'Prepare worktree'}
            </button>
          )}
        </details>
      </section>
      <section className="run-envelope">
        <details className="run-section-detail" open={envelope.state !== 'ready'}>
          <SectionSummary heading="Capability envelope" state={envelope.state} />
          {envelope.state !== 'pending' && (
            <dl className="run-intent-grid">
              {envelope.state === 'refused' && <div><dt>Refusal reason</dt><dd>{envelope.reason}</dd></div>}
              {envelope.state === 'ready' && (() => {
                const { runtime, profile } = envelope.capabilityEnvelope;
                return (
                  <>
                    <div><dt>Runtime</dt><dd>{formatRunLabel(runtime)}</dd></div>
                    <div>
                      <dt>Writable worktree</dt>
                      <dd>
                        <code>{profile.writableWorktree}</code>
                        <small>Git worktree of {run.spec.repository.name} · {run.spec.repository.path}</small>
                      </dd>
                    </div>
                  </>
                );
              })()}
            </dl>
          )}
          {envelope.state === 'ready' && (() => {
            const { profile, secretGrants } = envelope.capabilityEnvelope;
            return (
              <details className="run-technical-detail">
                <summary>Permissions &amp; limits</summary>
                <dl className="run-intent-grid">
                  <div><dt>Readable roots</dt><dd>{profile.readableRoots.map((root) => <code key={root}>{root}</code>)}</dd></div>
                  <div>
                    <dt>Allowed network domains</dt>
                    <dd>{profile.allowedNetworkDomains.length > 0
                      ? profile.allowedNetworkDomains.map((domain) => <code key={domain}>{domain}</code>)
                      : 'None (denied by default)'}</dd>
                  </div>
                  <div>
                    <dt>Inherited environment variables</dt>
                    <dd>{profile.environmentAllowlist.map((name) => <code key={name}>{name}</code>)}</dd>
                  </div>
                  <div><dt>Process ceiling</dt><dd>{profile.processCeiling}</dd></div>
                  <div><dt>Child-Run ceiling</dt><dd>{profile.childRunCeiling}</dd></div>
                  <div>
                    <dt>Secret grants</dt>
                    <dd>{secretGrants.length > 0
                      ? secretGrants.map((grant) => <span key={grant.name}>{grant.name}: <code>{grant.reference}</code></span>)
                      : 'None'}</dd>
                  </div>
                </dl>
              </details>
            );
          })()}
        </details>
      </section>
      <CompanionSessionsPanel companionSessions={companionSessions} onOpenCompanionSession={onOpenCompanionSession} />
      {structuredAttemptsEnabled && eligibleForStructuredAttempt && (
        <section className="run-attempt">
          <h2>Attempt</h2>
          <dl className="run-intent-grid">
            <div><dt>Runtime</dt><dd>{formatRunLabel(envelope.state === 'ready' ? envelope.capabilityEnvelope.runtime : '')}</dd></div>
            <div>
              <dt>Attempt state</dt>
              <dd><span className={`work-run-status status-${attempt.state}`}>{formatRunLabel(attempt.state)}</span></dd>
            </div>
            {attempt.state === 'failed' && <div><dt>Terminal outcome</dt><dd>Failed — {attempt.reason}</dd></div>}
            {attempt.state === 'completed' && (
              <div>
                <dt>Terminal outcome</dt>
                <dd>{(() => {
                  const last = attempt.events.at(-1);
                  return last?.kind === 'completion' ? `Completed — ${formatRunLabel(last.outcome)}` : 'Completed';
                })()}</dd>
              </div>
            )}
          </dl>
          {canStart && (
            <button className="button button-primary" onClick={() => onStart?.(run)} type="button">
              Start Attempt
            </button>
          )}
          {canRetryAttempt && (
            <button className="button" onClick={() => onRetryAttempt?.(run)} type="button">
              Start a new attempt
            </button>
          )}
          {(canPause || canResume) && (
            <div className="run-attention-actions" role="group" aria-label="Pause and resume">
              {canPause && (
                <button className="button" onClick={() => onPause?.(run)} type="button">
                  Pause
                </button>
              )}
              {canResume && (
                <button className="button button-primary" onClick={() => onResume?.(run)} type="button">
                  Resume
                </button>
              )}
            </div>
          )}
          {run.pendingAttention && (() => {
            const pending = run.pendingAttention;
            return (
              <section aria-labelledby="run-attention-title" className="run-attention-request" data-attention-kind={pending.kind}>
                <strong id="run-attention-title">{pending.kind === 'approval' ? 'Approval requested' : 'Input requested'}</strong>
                <p>{pending.reason}</p>
                {pending.kind === 'approval' ? (
                  <div className="run-attention-actions" role="group" aria-label="Approval response">
                    <button className="button" onClick={() => onResolveAttention?.(run, pending.id, { kind: 'deny' })} type="button">
                      Deny
                    </button>
                    <button className="button button-primary" onClick={() => onResolveAttention?.(run, pending.id, { kind: 'approve' })} type="button">
                      Approve
                    </button>
                  </div>
                ) : (
                  <AttentionInputForm onSubmit={(value) => onResolveAttention?.(run, pending.id, { kind: 'input', value })} />
                )}
              </section>
            );
          })()}
          {/*
           * Ticket 68 (B12): `run.attempts` (present on every real, store-
           * backed Run) renders the full history — a retried Run's first
           * attempt stays fully visible, never overwritten or hidden, once
           * a second one exists. Falls back to the single current attempt
           * for any caller/fixture that hasn't adopted `attempts` yet.
           */}
          {run.attempts && run.attempts.length > 0 ? (
            <div className="run-attempt-history">
              {run.attempts.map((record) => (
                <details className="run-section-detail" key={record.attemptId} open={record.ordinal === run.attempts!.length}>
                  <summary>
                    Attempt {record.ordinal} of {run.attempts!.length}
                    {' '}<span className={`work-run-status status-${record.state.state}`}>{formatRunLabel(record.state.state)}</span>
                  </summary>
                  {record.state.state !== 'idle' && <AttemptReport events={record.state.events} />}
                </details>
              ))}
            </div>
          ) : (
            attempt.state !== 'idle' && <AttemptReport events={attempt.events} />
          )}
        </section>
      )}
      <RunResultPanel onApply={onApply} onPreview={onPreview} onReverify={onReverify} onViewChanges={onViewChanges} run={run} />
      {/*
       * Ticket 13: publication is independent of the structured-attempts
       * experimental panel above — it depends only on run.status and a
       * delivery commit (findDeliveryCommit, inside PublicationPanel
       * itself), never on structuredAttemptsEnabled or the
       * eligibleForStructuredAttempt check above, so the admin's only way to authorize
       * a publish isn't hidden behind an unrelated, default-off feature
       * flag.
       */}
      <PublicationPanel onPublish={onPublish} run={run} />
      <RunFeedbackPanel runId={run.id} />
      <footer>Submitted {new Date(run.submittedAt).toLocaleString()} · Task {run.taskId}</footer>
    </article>
  );
}
