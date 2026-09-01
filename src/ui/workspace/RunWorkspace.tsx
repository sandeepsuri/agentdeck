import { useState } from 'react';
import type { AttemptEvent, AttentionDecisionInput, WorkRun } from '../../work-engine/types.js';
import { formatRunLabel } from './runModel.js';

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

interface Props {
  run: WorkRun;
  onPrepare?: (run: WorkRun) => void;
  onStart?: (run: WorkRun) => void;
  /** Ticket 07: routes an operator decision for run.pendingAttention through the one Work Engine policy path (App.tsx's resolveRunAttention → POST /api/runs/:id/attention/:attentionId/{approve,deny,input}). */
  onResolveAttention?: (run: WorkRun, attentionId: string, decision: AttentionDecisionInput) => void;
  /** Ticket 05: the structured Attempt panel is experimental and stays hidden until this feature gate is on. */
  structuredAttemptsEnabled?: boolean;
}

export function RunWorkspace({
  run, onPrepare, onStart, onResolveAttention, structuredAttemptsEnabled = false,
}: Props) {
  const { preparation, envelope, attempt } = run;
  const canPrepare = (preparation.state === 'pending' || preparation.state === 'failed') && onPrepare;
  const eligibleForCodexAttempt = preparation.state === 'ready' && envelope.state === 'ready'
    && envelope.capabilityEnvelope.runtime === 'codex';
  const canStart = structuredAttemptsEnabled && eligibleForCodexAttempt && attempt.state === 'idle' && Boolean(onStart);
  return (
    <article className="run-workspace">
      <header>
        <span><small>Run {run.id}</small><h1>{run.spec.objective}</h1></span>
        <span className={`work-run-status status-${run.status}`}>{formatRunLabel(run.status)}</span>
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
          <div><dt>Worktree</dt><dd>{preparation.worktreePath ? <code>{preparation.worktreePath}</code> : 'Not yet created'}</dd></div>
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
                <div><dt>Writable worktree</dt><dd><code>{profile.writableWorktree}</code></dd></div>
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
      {structuredAttemptsEnabled && eligibleForCodexAttempt && (
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
          {attempt.state !== 'idle' && (
            <ol className="run-attempt-activity">
              {attempt.events.map((event) => {
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
        </section>
      )}
      <footer>Submitted {new Date(run.submittedAt).toLocaleString()} · Task {run.taskId}</footer>
    </article>
  );
}
