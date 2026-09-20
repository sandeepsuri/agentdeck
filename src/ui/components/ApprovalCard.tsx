// Redesign spec §08: an approval explains intent, command, scope, requested
// access and risk before the human decides. The decision itself is unchanged —
// onApprove/onDeny still go through the one Work Engine attention path.
import { classifyApproval, parseApprovalReason, RISK_LABELS } from '../risk.js';

interface Props {
  reason: string;
  /** Why the agent is doing this: the objective of the work it belongs to. */
  intent?: string;
  repositoryName: string;
  workingDirectory?: string;
  fallbackAgent?: string;
  busy?: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalCard({ reason, intent, repositoryName, workingDirectory, fallbackAgent = 'The agent', busy = false, onApprove, onDeny }: Props) {
  const parsed = parseApprovalReason(reason);
  const classification = classifyApproval(parsed);
  const agent = parsed.agent ?? fallbackAgent;
  const accessRows: [keyof typeof classification.access, string][] = [['network', 'Network'], ['files', 'Files'], ['secrets', 'Secrets']];
  return (
    <section aria-label={`${agent} wants permission`} className={`approval-card risk-${classification.risk}`}>
      <header>
        <small>{agent} wants permission</small>
        <strong>{classification.category}{parsed.tool && !parsed.command ? ` · ${parsed.tool}` : ''}</strong>
        <span className={`risk-badge risk-${classification.risk}`}>Risk · {RISK_LABELS[classification.risk]}</span>
      </header>
      {parsed.command ? <code className="approval-command">{parsed.command}</code> : <p className="approval-reason">{reason}</p>}
      <dl className="approval-facts">
        {intent && <div><dt>Why</dt><dd>{intent}</dd></div>}
        <div>
          <dt>Scope</dt>
          <dd>Repository: {repositoryName}{workingDirectory && <><br />Working directory: <code>{workingDirectory}</code></>}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd className="approval-access">
            {accessRows.map(([key, label]) => (
              <span className={classification.access[key] ? 'is-requested' : ''} key={key}>
                <i aria-hidden="true">{classification.access[key] ? '●' : '○'}</i>{label}
                <span className="sr-only">{classification.access[key] ? ' requested' : ' not requested'}</span>
              </span>
            ))}
          </dd>
        </div>
      </dl>
      <div className="approval-actions" role="group" aria-label="Approval response">
        <button className="button" disabled={busy} onClick={onDeny} type="button">Deny</button>
        <button className="button button-primary" disabled={busy} onClick={onApprove} type="button">Approve once</button>
      </div>
    </section>
  );
}
