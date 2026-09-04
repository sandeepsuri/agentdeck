import { useState } from 'react';
import { deriveRunResult } from '../../work-engine/run-result.js';
import { defaultPublicationTarget } from '../../work-engine/publication.js';
import type {
  AttemptEvent, AttentionDecisionInput, PublicationTarget, RunPublication, WorkRun,
} from '../../work-engine/types.js';
import {
  describeOutcome, formatTokenCount, summarizeAttempt, type ActivityStatus,
} from './attemptActivity.js';
import { formatRunLabel, isTerminalRunStatus } from './runModel.js';

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
function RunResultPanel({ run, onApply, onReverify, onViewChanges }: {
  run: WorkRun;
  onApply?: (run: WorkRun) => void;
  onReverify?: (run: WorkRun) => void;
  onViewChanges?: (run: WorkRun) => void;
}) {
  const result = deriveRunResult(run);
  if (!result) return null;
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
      </div>
    </section>
  );
}

interface Props {
  run: WorkRun;
  onPrepare?: (run: WorkRun) => void;
  onStart?: (run: WorkRun) => void;
  onApply?: (run: WorkRun) => void;
  onReverify?: (run: WorkRun) => void;
  onViewChanges?: (run: WorkRun) => void;
  /** Ticket 07: routes an operator decision for run.pendingAttention through the one Work Engine policy path (App.tsx's resolveRunAttention → POST /api/runs/:id/attention/:attentionId/{approve,deny,input}). */
  onResolveAttention?: (run: WorkRun, attentionId: string, decision: AttentionDecisionInput) => void;
  /** Ticket 13: the admin's explicit publish authorization (App.tsx's publishRun → POST /api/runs/:id/publish). Absent means the action is not offered at all. */
  onPublish?: (run: WorkRun, target: PublicationTarget) => void;
  /** Permanently removes this Run from history (App.tsx's deleteRun → DELETE /api/runs/:id). Only offered once the Run has reached a terminal status — see isTerminalRunStatus. */
  onDelete?: (run: WorkRun) => void;
  /** Ticket 05: the structured Attempt panel is experimental and stays hidden until this feature gate is on. */
  structuredAttemptsEnabled?: boolean;
}

export function RunWorkspace({
  run, onPrepare, onStart, onApply, onReverify, onViewChanges, onResolveAttention, onPublish, onDelete,
  structuredAttemptsEnabled = false,
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
        <h2>Worktree preparation</h2>
        <dl className="run-intent-grid">
          <div>
            <dt>Preparation state</dt>
            <dd><span className={`work-run-status status-${preparation.state}`}>{formatRunLabel(preparation.state)}</span></dd>
          </div>
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
      </section>
      <section className="run-envelope">
        <h2>Capability envelope</h2>
        <dl className="run-intent-grid">
          <div>
            <dt>Status</dt>
            <dd><span className={`work-run-status status-${envelope.state}`}>{formatRunLabel(envelope.state)}</span></dd>
          </div>
          {envelope.state === 'refused' && <div><dt>Refusal reason</dt><dd>{envelope.reason}</dd></div>}
          {envelope.state === 'ready' && (() => {
            const { runtime, profile, secretGrants } = envelope.capabilityEnvelope;
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
              </>
            );
          })()}
        </dl>
      </section>
      {structuredAttemptsEnabled && eligibleForStructuredAttempt && (
        <section className="run-attempt">
          <h2>Attempt</h2>
          <dl className="run-intent-grid">
            <div><dt>Objective</dt><dd>{run.spec.objective}</dd></div>
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
          {attempt.state !== 'idle' && <AttemptReport events={attempt.events} />}
        </section>
      )}
      <RunResultPanel onApply={onApply} onReverify={onReverify} onViewChanges={onViewChanges} run={run} />
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
      <footer>Submitted {new Date(run.submittedAt).toLocaleString()} · Task {run.taskId}</footer>
    </article>
  );
}
