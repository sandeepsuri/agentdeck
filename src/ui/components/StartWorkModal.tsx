// Redesign spec §05: "+ Start work" replaces the separate New run and Launch
// agent entry points. The person describes the work once; the mode decides
// whether AgentDeck launches an ad hoc Session (Quick → POST /api/sessions)
// or submits a durable Run with a definition of done (Structured →
// PUT verification policy, then POST /api/runs). Both requests are exactly
// the ones LaunchModal and the former RunSubmissionModal made — this changes
// the entry point, not the execution model. LaunchModal's full options
// (environment, permission mode, free path) stay one click away.
import { useEffect, useState } from 'react';
import type { RuntimeReadinessReport, RuntimeReadinessStatus } from '../../sessions/runtime-readiness-contract.js';
import type { Repo, Session } from '../../types.js';
import type { RepositoryVerificationPolicy, RequestedDeliveryResult, WorkRun, WorkSpec } from '../../work-engine/types.js';
import { apiFetch } from '../apiFetch.js';
import {
  type AgentChoice, quickSessionName, resolveQuickAgent, resolveStructuredRuntimes, type StartWorkMode,
} from '../workspace/startWork.js';
import { lines, runtimeSelectableForManagedRun, saveRepositoryVerificationPolicy, submitWorkRun } from './workSubmission.js';

const READINESS_LABELS: Record<RuntimeReadinessStatus, string> = {
  managed: 'Managed runs ready',
  'compatibility-only': 'Compatibility only',
  unavailable: 'Unavailable',
};

export interface StartWorkDraft {
  task: string;
  repoPath: string;
  agent: AgentChoice;
}

interface Props {
  repos: Repo[];
  /** Preselects the repository currently filtering Work/Review, when there is one. */
  initialRepositoryId?: string | null;
  /** Prefills the task — Home's Ask hands its text here unsent (#79). */
  initialTask?: string;
  onClose: () => void;
  onError: (message: string) => void;
  onLaunched: (session: Session) => void;
  onSubmitted: (run: WorkRun) => void;
  /** Opens the full session launcher (environment, permission mode, free path) with what was typed so far. */
  onAdvanced?: (draft: StartWorkDraft) => void;
}

export function StartWorkModal({ repos, initialRepositoryId = null, initialTask = '', onClose, onError, onLaunched, onSubmitted, onAdvanced }: Props) {
  const [task, setTask] = useState(initialTask);
  const [repositoryId, setRepositoryId] = useState(() => repos.find((repo) => repo.id === initialRepositoryId)?.id ?? repos[0]?.id ?? '');
  const repository = repos.find((repo) => repo.id === repositoryId) ?? repos[0];
  const [agent, setAgent] = useState<AgentChoice>('auto');
  const [mode, setMode] = useState<StartWorkMode>('quick');
  const [branch, setBranch] = useState('');
  const [createBranch, setCreateBranch] = useState(false);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [requestedBaseReference, setRequestedBaseReference] = useState(repository?.currentBranch ?? 'HEAD');
  const [wallClockMinutes, setWallClockMinutes] = useState('60');
  const [modelTurns, setModelTurns] = useState('50');
  const [verificationRequired, setVerificationRequired] = useState(true);
  const [verificationCommands, setVerificationCommands] = useState('npm test\nnpm run typecheck');
  const [delivery, setDelivery] = useState<RequestedDeliveryResult>('apply-to-repository');
  const [verificationPolicyState, setVerificationPolicyState] = useState<'loading' | 'configured' | 'missing'>('loading');
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    apiFetch('/api/runtime-readiness')
      .then((response) => response.ok ? response.json() as Promise<RuntimeReadinessReport> : null)
      .then((body) => { if (!disposed && body) setRuntimeReadiness(body); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Keyed on the id, not the object: App re-fetches `repos` every few seconds,
  // and a new object must not reload the policy over commands being edited.
  const repositoryKey = repository?.id;
  useEffect(() => {
    if (mode !== 'structured' || !repositoryKey) return;
    let disposed = false;
    setVerificationPolicyState('loading');
    apiFetch(`/api/repos/verification-policy?repoId=${encodeURIComponent(repositoryKey)}`)
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
  }, [mode, repositoryKey]);

  const structuredRuntimes = resolveStructuredRuntimes(agent, runtimeReadiness);
  const canSubmit = Boolean(task.trim()) && Boolean(repository) && !submitting
    && (mode === 'quick' || (structuredRuntimes.length > 0 && lines(acceptanceCriteria).length > 0));

  const startQuick = async (repo: Repo) => {
    const name = quickSessionName(task);
    const response = await apiFetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: resolveQuickAgent(agent, runtimeReadiness), cwd: repo.path, permissionMode: 'default',
        ...(name ? { name } : {}), initialPrompt: task.trim(),
        ...(branch.trim() ? { branch: branch.trim(), createBranchIfMissing: createBranch } : {}),
      }),
    });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Starting work failed (${response.status})`);
    onLaunched(body);
  };

  const startStructured = async (repo: Repo) => {
    const commands = lines(verificationCommands);
    if (verificationRequired && commands.length === 0) {
      throw new Error('Add at least one verification command or explicitly allow unverified work.');
    }
    const policy: RepositoryVerificationPolicy = verificationRequired
      ? { kind: 'required', gates: commands.map((command) => ({ name: command, command })) }
      : { kind: 'no-verification' };
    const spec: WorkSpec = {
      objective: task.trim(),
      acceptanceCriteria: lines(acceptanceCriteria),
      repository: { id: repo.id, name: repo.name, path: repo.path },
      requestedBaseReference,
      runtimePreference: structuredRuntimes,
      budget: { maxWallClockMs: Number(wallClockMinutes) * 60_000, maxModelTurns: Number(modelTurns) },
      // Required Repository gates are stored outside the worktree so the
      // runtime cannot rewrite them; the Run adds no duplicate gates itself.
      verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: delivery,
    };
    await saveRepositoryVerificationPolicy(repo.id, policy);
    onSubmitted(await submitWorkRun(spec));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repository) return onError('Choose a repository before starting work.');
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await (mode === 'quick' ? startQuick(repository) : startStructured(repository));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="start-work-title" aria-modal="true" className="run-submission-modal start-work-modal" role="dialog">
        <header><h2 id="start-work-title">Start work</h2><button aria-label="Close" onClick={onClose} type="button">×</button></header>
        <form onSubmit={(event) => { void submit(event); }}>
          <label>What do you want done?<textarea autoFocus onChange={(event) => setTask(event.target.value)} placeholder="Describe the task…" required rows={3} value={task} /></label>
          <div className="run-form-grid">
            <label>Repository<select onChange={(event) => {
              setRepositoryId(event.target.value);
              const selected = repos.find((item) => item.id === event.target.value);
              if (selected?.currentBranch) setRequestedBaseReference(selected.currentBranch);
            }} required value={repository?.id ?? ''}>
              <option disabled value="">Choose a repository</option>
              {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
            </select></label>
            <label>Agent<select onChange={(event) => setAgent(event.target.value as AgentChoice)} value={agent}>
              <option value="auto">Auto</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select></label>
          </div>
          <fieldset className="start-work-mode">
            <legend>Mode</legend>
            <label><input checked={mode === 'quick'} name="start-work-mode" onChange={() => setMode('quick')} type="radio" /><span><strong>Quick</strong><small>Ad hoc request in a coding session</small></span></label>
            <label><input checked={mode === 'structured'} name="start-work-mode" onChange={() => setMode('structured')} type="radio" /><span><strong>Structured</strong><small>Durable work with a definition of done</small></span></label>
          </fieldset>

          {mode === 'quick' && (
            <div className="start-work-section">
              <div className="run-form-grid">
                <label>Branch (optional)<input onChange={(event) => setBranch(event.target.value)} placeholder="Keep current branch" value={branch} /></label>
                <label className="run-check start-work-inline-check"><input checked={createBranch} disabled={!branch.trim()} onChange={(event) => setCreateBranch(event.target.checked)} type="checkbox" />Create branch if missing</label>
              </div>
              {onAdvanced && <button className="text-button" onClick={() => onAdvanced({ task, repoPath: repository?.path ?? '', agent })} type="button">More session options…</button>}
            </div>
          )}

          {mode === 'structured' && (
            <div className="start-work-section">
              <label>Acceptance criteria<textarea onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="One criterion per line" required value={acceptanceCriteria} /></label>
              <div className="run-choice-row start-work-readiness">
                {(['codex', 'claude'] as const).map((runtime) => {
                  const readiness = runtimeReadiness?.runtimes.find((item) => item.runtime === runtime);
                  if (!readiness || (agent !== 'auto' && agent !== runtime)) return null;
                  return (
                    <span className={runtimeSelectableForManagedRun(runtimeReadiness, runtime) ? 'is-ready' : 'is-blocked'} key={runtime}>
                      <strong>{runtime === 'codex' ? 'Codex' : 'Claude'}</strong>
                      <small className={`run-runtime-readiness status-${readiness.status}`}> {READINESS_LABELS[readiness.status]}</small>
                      {readiness.status !== 'managed' && <small className="run-runtime-reason">{readiness.reason}</small>}
                    </span>
                  );
                })}
              </div>
              {structuredRuntimes.length === 0 && <p className="form-error">No selected agent can run structured work right now.</p>}
              <label>Verification commands<textarea disabled={!verificationRequired} onChange={(event) => setVerificationCommands(event.target.value)} value={verificationCommands} /></label>
              <label className="run-check"><input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />Require these commands to pass before delivery</label>
              <small className="field-hint-block">{verificationPolicyState === 'loading' ? 'Loading saved policy…' : verificationPolicyState === 'configured' ? 'Saved for this repository. Starting updates it.' : 'Not configured yet. Starting will save this policy first.'}</small>
              <div className="run-form-grid">
                <label>Time limit (minutes)<input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} required type="number" value={wallClockMinutes} /></label>
                <label>Turn limit<input min="1" onChange={(event) => setModelTurns(event.target.value)} required type="number" value={modelTurns} /></label>
              </div>
              <div className="run-form-grid">
                <label>Base branch<input onChange={(event) => setRequestedBaseReference(event.target.value)} required value={requestedBaseReference} /></label>
                <label>Delivery target<select onChange={(event) => setDelivery(event.target.value as RequestedDeliveryResult)} value={delivery}>
                  <option value="apply-to-repository">Apply to repository (recommended)</option>
                  <option value="local-commit">Create branch and commit</option>
                  <option value="pull-request">Open draft pull request</option>
                  <option value="working-tree">Keep in AgentDeck for review</option>
                </select></label>
              </div>
            </div>
          )}

          <footer>
            <button className="button" onClick={onClose} type="button">Cancel</button>
            <button className="button button-primary" disabled={!canSubmit} type="submit">{submitting ? 'Starting…' : 'Start →'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
