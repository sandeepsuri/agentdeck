import type { WorkRun } from '../../work-engine/types.js';
import { formatRunLabel } from './runModel.js';

export function RunWorkspace({ run }: { run: WorkRun }) {
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
      <footer>Submitted {new Date(run.submittedAt).toLocaleString()} · Task {run.taskId}</footer>
    </article>
  );
}
