import { useEffect, useState } from 'react';
import type {
  RuntimeReadinessReport, RuntimeReadinessStatus,
} from '../../sessions/runtime-readiness-contract.js';
import type { AgentType, Repo } from '../../types.js';
import type {
  RepositoryVerificationPolicy, RequestedDeliveryResult, WorkRun, WorkSpec,
} from '../../work-engine/types.js';
import { apiFetch } from '../apiFetch.js';

// Mirrors LaunchModal's READINESS_LABELS — kept local rather than shared
// since each modal renders it at a different level of detail.
const READINESS_LABELS: Record<RuntimeReadinessStatus, string> = {
  managed: 'Managed runs ready',
  'compatibility-only': 'Compatibility only',
  unavailable: 'Unavailable',
};

/**
 * Ticket 14 AC6: a runtime whose installation cannot satisfy the managed
 * capability envelope may not be picked for a managed Run at all — the same
 * rule buildRunEnvelope() enforces (work-engine/envelope.ts), applied here
 * so an operator is told why up front instead of watching the Run be
 * refused after it is submitted. Absent readiness evidence never blocks a
 * choice: not knowing yet is not the same as knowing it is unsupported.
 * This reads only the shared readiness report, so it stays one rule for
 * every runtime rather than a per-provider branch (AC8).
 */
export function runtimeSelectableForManagedRun(
  readiness: RuntimeReadinessReport | null,
  runtime: AgentType,
): boolean {
  const entry = readiness?.runtimes.find((item) => item.runtime === runtime);
  return entry === undefined || entry.status === 'managed';
}

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

export async function saveRepositoryVerificationPolicy(
  repoId: string,
  policy: RepositoryVerificationPolicy,
  fetcher: RunFetcher = apiFetch,
): Promise<void> {
  const response = await fetcher('/api/repos/verification-policy', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId, policy }),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Saving the Repository verification policy failed.');
}

interface Props {
  repos: Repo[];
  onClose: () => void;
  onSubmitted: (run: WorkRun) => void;
  onError: (message: string) => void;
}

/** Shared with CollaboratorLaunchPanel (MobileWorkspace.tsx) and CreateProfileForm (CollaboratorsPanel.tsx) — every "one item per line" textarea in this app parses the same way. */
export function lines(value: string): string[] {
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
  const [delivery, setDelivery] = useState<RequestedDeliveryResult>('apply-to-repository');
  const [submitting, setSubmitting] = useState(false);
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);
  const [verificationPolicyState, setVerificationPolicyState] = useState<'loading' | 'configured' | 'missing'>('loading');

  useEffect(() => {
    let disposed = false;
    apiFetch('/api/runtime-readiness')
      .then((response) => response.ok ? response.json() as Promise<RuntimeReadinessReport> : null)
      .then((body) => {
        if (disposed || !body) return;
        setRuntimeReadiness(body);
        // AC6: a runtime the evidence now says cannot run managed work is
        // dropped from the preference rather than left selected and refused
        // later — including the default 'codex' this form starts with.
        setRuntimePreference((current) => current.filter((runtime) => runtimeSelectableForManagedRun(body, runtime)));
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!repositoryId) return;
    let disposed = false;
    setVerificationPolicyState('loading');
    apiFetch(`/api/repos/verification-policy?repoId=${encodeURIComponent(repositoryId)}`)
      .then(async (response) => {
        const body = await response.json() as { policy?: RepositoryVerificationPolicy | null };
        if (!response.ok) throw new Error('Could not load verification policy.');
        return body.policy ?? null;
      })
      .then((policy) => {
        if (disposed) return;
        setVerificationPolicyState(policy ? 'configured' : 'missing');
        if (policy?.kind === 'required') {
          setVerificationRequired(true);
          setVerificationCommands(policy.gates.map((gate) => gate.command).join('\n'));
        } else if (policy?.kind === 'no-verification') {
          setVerificationRequired(false);
        }
      })
      .catch(() => { if (!disposed) setVerificationPolicyState('missing'); });
    return () => { disposed = true; };
  }, [repositoryId]);

  const toggleRuntime = (runtime: AgentType) => {
    if (!runtimeSelectableForManagedRun(runtimeReadiness, runtime)) return;
    setRuntimePreference((current) => current.includes(runtime)
      ? current.filter((item) => item !== runtime)
      : [...current, runtime]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repository) return onError('Choose a repository before submitting work.');
    const commands = lines(verificationCommands);
    if (verificationRequired && commands.length === 0) {
      return onError('Add at least one verification command or explicitly allow unverified work.');
    }
    const repositoryPolicy: RepositoryVerificationPolicy = verificationRequired
      ? { kind: 'required', gates: commands.map((command) => ({ name: command, command })) }
      : { kind: 'no-verification' };
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
      // Required Repository gates are stored outside the worktree so the
      // runtime cannot rewrite them. This Run adds no duplicate supplemental
      // gates of its own.
      verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: delivery,
    };
    setSubmitting(true);
    try {
      await saveRepositoryVerificationPolicy(repository.id, repositoryPolicy);
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
            const selectable = runtimeSelectableForManagedRun(runtimeReadiness, runtime);
            return (
              <label key={runtime}>
                <input checked={runtimePreference.includes(runtime)} disabled={!selectable} onChange={() => toggleRuntime(runtime)} type="checkbox" />
                {runtime === 'codex' ? 'Codex' : 'Claude'}
                {readiness && <small className={`run-runtime-readiness status-${readiness.status}`}> {READINESS_LABELS[readiness.status]}</small>}
                {/* AC6: the precise reason, not just the status — an operator
                    seeing a runtime they cannot pick is owed what is missing. */}
                {readiness && !selectable && <small className="run-runtime-reason">{readiness.reason}</small>}
              </label>
            );
          })}</div></fieldset>
          <fieldset><legend>Budget</legend><div className="run-form-grid"><label>Wall-clock minutes<input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} required type="number" value={wallClockMinutes} /></label><label>Model turns<input min="1" onChange={(event) => setModelTurns(event.target.value)} required type="number" value={modelTurns} /></label></div></fieldset>
          <fieldset>
            <legend>Repository verification policy</legend>
            <label className="run-check"><input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />Require these commands to pass before delivery</label>
            <label>Commands<textarea disabled={!verificationRequired} onChange={(event) => setVerificationCommands(event.target.value)} value={verificationCommands} /></label>
            <small>{verificationPolicyState === 'loading' ? 'Loading saved policy…' : verificationPolicyState === 'configured' ? 'Saved for this Repository. Submitting updates it.' : 'Not configured yet. Submitting will save this policy before the Run starts.'}</small>
            {!verificationRequired && <small>This Run will be marked unverified, but its requested local result can still be delivered.</small>}
          </fieldset>
          <label>Requested delivery result<select onChange={(event) => setDelivery(event.target.value as RequestedDeliveryResult)} value={delivery}><option value="apply-to-repository">Apply to repository (recommended)</option><option value="local-commit">Create run branch and commit</option><option value="pull-request">Open draft pull request</option><option value="working-tree">Keep in AgentDeck for review</option></select></label>
          <footer><button className="button" onClick={onClose} type="button">Cancel</button><button className="button button-primary" disabled={submitting || runtimePreference.length === 0 || repos.length === 0} type="submit">{submitting ? 'Submitting…' : 'Queue run'}</button></footer>
        </form>
      </section>
    </div>
  );
}
