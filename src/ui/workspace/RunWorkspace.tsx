import type { WorkRun } from '../../work-engine/types.js';
import { formatRunLabel } from './runModel.js';

export function RunWorkspace({ run, onPrepare }: { run: WorkRun; onPrepare?: (run: WorkRun) => void }) {
  const { preparation, envelope } = run;
  const canPrepare = (preparation.state === 'pending' || preparation.state === 'failed') && onPrepare;
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
      <footer>Submitted {new Date(run.submittedAt).toLocaleString()} · Task {run.taskId}</footer>
    </article>
  );
}
