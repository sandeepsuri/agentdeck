import { useEffect, useState } from 'react';
import type {
  RuntimeReadinessReport, RuntimeReadinessStatus,
} from '../../sessions/runtime-readiness-contract.js';
import type { AgentType, Repo } from '../../types.js';
import type { RequestedDeliveryResult, WorkRun, WorkSpec } from '../../work-engine/types.js';
import { apiFetch } from '../apiFetch.js';

// Mirrors LaunchModal's READINESS_LABELS — kept local rather than shared
// since each modal renders it at a different level of detail.
const READINESS_LABELS: Record<RuntimeReadinessStatus, string> = {
  managed: 'Managed runs ready',
  'compatibility-only': 'Compatibility only',
  unavailable: 'Unavailable',
};

type RunFetcher = (path: string, init: RequestInit) => Promise<Response>;

export async function submitWorkRun(spec: WorkSpec, fetcher: RunFetcher = apiFetch): Promise<WorkRun> {
  const response = await fetcher('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  const body = await response.json() as WorkRun & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Run submission failed.');
  return body;
}

interface Props {
  repos: Repo[];
  onClose: () => void;
  onSubmitted: (run: WorkRun) => void;
  onError: (message: string) => void;
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function RunSubmissionModal({ repos, onClose, onSubmitted, onError }: Props) {
  const [objective, setObjective] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [repositoryId, setRepositoryId] = useState(repos[0]?.id ?? '');
  const repository = repos.find((item) => item.id === repositoryId) ?? repos[0];
  const [requestedBaseReference, setRequestedBaseReference] = useState(repository?.currentBranch ?? 'HEAD');
  const [runtimePreference, setRuntimePreference] = useState<AgentType[]>(['codex']);
  const [wallClockMinutes, setWallClockMinutes] = useState('60');
  const [modelTurns, setModelTurns] = useState('50');
  const [verificationRequired, setVerificationRequired] = useState(true);
  const [verificationCommands, setVerificationCommands] = useState('npm test\nnpm run typecheck');
  const [delivery, setDelivery] = useState<RequestedDeliveryResult>('local-commit');
  const [submitting, setSubmitting] = useState(false);
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);

  useEffect(() => {
    let disposed = false;
    apiFetch('/api/runtime-readiness')
      .then((response) => response.ok ? response.json() as Promise<RuntimeReadinessReport> : null)
      .then((body) => { if (!disposed && body) setRuntimeReadiness(body); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  const toggleRuntime = (runtime: AgentType) => {
    setRuntimePreference((current) => current.includes(runtime)
      ? current.filter((item) => item !== runtime)
      : [...current, runtime]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repository) return onError('Choose a repository before submitting work.');
    const spec: WorkSpec = {
      objective,
      acceptanceCriteria: lines(acceptanceCriteria),
      repository: { id: repository.id, name: repository.name, path: repository.path },
      requestedBaseReference,
      runtimePreference,
      budget: {
        maxWallClockMs: Number(wallClockMinutes) * 60_000,
        maxModelTurns: Number(modelTurns),
      },
      verificationIntent: { required: verificationRequired, commands: lines(verificationCommands) },
      requestedDeliveryResult: delivery,
    };
    setSubmitting(true);
    try {
      onSubmitted(await submitWorkRun(spec));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="run-submission-title" aria-modal="true" className="run-submission-modal" role="dialog">
        <header><span><small>Managed work</small><h2 id="run-submission-title">Submit durable run</h2></span><button aria-label="Close" onClick={onClose} type="button">×</button></header>
        <form onSubmit={(event) => { void submit(event); }}>
          <label>Objective<textarea autoFocus onChange={(event) => setObjective(event.target.value)} required value={objective} /></label>
          <label>Acceptance criteria<textarea onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="One criterion per line" required value={acceptanceCriteria} /></label>
          <div className="run-form-grid">
            <label>Repository<select onChange={(event) => {
              setRepositoryId(event.target.value);
              const selected = repos.find((item) => item.id === event.target.value);
              if (selected?.currentBranch) setRequestedBaseReference(selected.currentBranch);
            }} required value={repositoryId}><option disabled value="">Choose a repository</option>{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
            <label>Requested base reference<input onChange={(event) => setRequestedBaseReference(event.target.value)} required value={requestedBaseReference} /></label>
          </div>
          <fieldset><legend>Runtime preference</legend><div className="run-choice-row">{(['codex', 'claude'] as const).map((runtime) => {
            const readiness = runtimeReadiness?.runtimes.find((item) => item.runtime === runtime);
            return (
              <label key={runtime}>
                <input checked={runtimePreference.includes(runtime)} onChange={() => toggleRuntime(runtime)} type="checkbox" />
                {runtime === 'codex' ? 'Codex' : 'Claude'}
                {readiness && <small className={`run-runtime-readiness status-${readiness.status}`}> {READINESS_LABELS[readiness.status]}</small>}
              </label>
            );
          })}</div></fieldset>
          <fieldset><legend>Budget</legend><div className="run-form-grid"><label>Wall-clock minutes<input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} required type="number" value={wallClockMinutes} /></label><label>Model turns<input min="1" onChange={(event) => setModelTurns(event.target.value)} required type="number" value={modelTurns} /></label></div></fieldset>
          <fieldset><legend>Verification intent</legend><label className="run-check"><input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />Verification is required</label><label>Commands<textarea onChange={(event) => setVerificationCommands(event.target.value)} value={verificationCommands} /></label></fieldset>
          <label>Requested delivery result<select onChange={(event) => setDelivery(event.target.value as RequestedDeliveryResult)} value={delivery}><option value="working-tree">Working tree</option><option value="local-commit">Local commit</option><option value="pull-request">Pull request</option></select></label>
          <footer><button className="button" onClick={onClose} type="button">Cancel</button><button className="button button-primary" disabled={submitting || runtimePreference.length === 0 || repos.length === 0} type="submit">{submitting ? 'Submitting…' : 'Queue run'}</button></footer>
        </form>
      </section>
    </div>
  );
}
