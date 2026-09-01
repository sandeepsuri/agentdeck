import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RUNTIME_CAPABILITY_LABELS,
  type RuntimeReadinessReport,
  type RuntimeReadinessStatus,
} from '../../sessions/runtime-readiness-contract.js';
import type { AgentType, Repo, Session } from '../../types.js';
import { apiFetch } from '../apiFetch.js';
import './LaunchModal.css';

interface EnvRow { key: string; value: string }
type PermissionMode = 'default' | 'acceptEdits' | 'plan';

interface PreflightResult {
  ready: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
}

export interface LaunchModalProps {
  repos: Repo[];
  onClose: () => void;
  onLaunched: (session: Session) => void;
}

const PERMISSIONS: { value: PermissionMode; label: string; icon: string; description: string }[] = [
  { value: 'default', label: 'Ask', icon: '✋', description: 'Approve before commands run' },
  { value: 'acceptEdits', label: 'Auto-edit', icon: '✎', description: 'Edit files without asking' },
  { value: 'plan', label: 'Plan', icon: '☰', description: 'Plan first, wait for approval' },
];

const READINESS_LABELS: Record<RuntimeReadinessStatus, string> = {
  managed: 'Managed runs ready',
  'compatibility-only': 'Compatibility sessions only',
  unavailable: 'Unavailable',
};

function parseEnvFile(contents: string): EnvRow[] {
  return contents.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
    const index = line.indexOf('=');
    return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2') };
  });
}

export function LaunchModal({ repos, onClose, onLaunched }: LaunchModalProps) {
  const [agent, setAgent] = useState<AgentType>('claude');
  const [workspaceMode, setWorkspaceMode] = useState<'repo' | 'free'>(repos.length ? 'repo' : 'free');
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? '');
  const [freePath, setFreePath] = useState('');
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [createBranch, setCreateBranch] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);
  const [readinessFailed, setReadinessFailed] = useState(false);
  const envFileRef = useRef<HTMLInputElement | null>(null);
  const cwd = workspaceMode === 'repo' ? repoPath : freePath.trim();
  const selectedRepo = repos.find((repo) => repo.path === repoPath);
  const selectedRuntimeReadiness = runtimeReadiness?.runtimes.find((item) => item.runtime === agent);

  useEffect(() => {
    let disposed = false;
    apiFetch('/api/runtime-readiness')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Readiness check failed (${response.status})`);
        return response.json() as Promise<RuntimeReadinessReport>;
      })
      .then((body) => { if (!disposed) setRuntimeReadiness(body); })
      .catch(() => { if (!disposed) setReadinessFailed(true); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    setPreflight(null);
    if (!cwd) return;
    let disposed = false;
    const timer = setTimeout(() => {
      apiFetch('/api/launch/preflight', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, cwd, branch: branch.trim() || undefined, createBranchIfMissing: createBranch }),
      }).then((response) => response.json()).then((body: PreflightResult) => { if (!disposed) setPreflight(body); }).catch(() => { if (!disposed) setPreflight(null); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [agent, branch, createBranch, cwd]);

  const manifest = useMemo(() => [
    ['Agent', agent === 'claude' ? 'Claude Code' : 'Codex CLI'],
    ['Directory', cwd || '—'],
    ['Name', name.trim() || '—'],
    ['Branch', branch.trim() || selectedRepo?.currentBranch || 'current'],
    ['Mode', PERMISSIONS.find((item) => item.value === permissionMode)?.label ?? permissionMode],
    ['Environment', `${envRows.filter((row) => row.key.trim()).length} variables`],
  ], [agent, branch, cwd, envRows, name, permissionMode, selectedRepo?.currentBranch]);

  const command = useMemo(() => [
    `$ agentdeck launch ${agent}`,
    `    --cwd ${cwd || '<directory>'}`,
    ...(branch.trim() ? [`    --branch ${branch.trim()}`] : []),
    `    --permission ${permissionMode === 'default' ? 'ask' : permissionMode === 'acceptEdits' ? 'auto-edit' : 'plan'}`,
  ], [agent, branch, cwd, permissionMode]);

  const updateEnv = (index: number, field: keyof EnvRow, value: string) => setEnvRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));

  const submit = async () => {
    if (!cwd || submitting) return setError('Choose a repository or enter a working directory.');
    setSubmitting(true);
    setError(null);
    const env = Object.fromEntries(envRows.map((row) => [row.key.trim(), row.value] as const).filter(([key]) => key));
    try {
      const response = await apiFetch('/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, cwd, permissionMode, ...(name.trim() ? { name: name.trim() } : {}), ...(branch.trim() ? { branch: branch.trim(), createBranchIfMissing: createBranch } : {}), ...(prompt.trim() ? { initialPrompt: prompt } : {}), ...(Object.keys(env).length ? { env } : {}) }),
      });
      const body = await response.json() as Session & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Launch failed (${response.status})`);
      onLaunched(body);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="launch-backdrop" onMouseDown={onClose} role="presentation">
      <section aria-label="Launch agent" aria-modal="true" className="launch-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="launch-header">
          <span className="launch-mark">&gt;_</span>
          <span><strong>Launch agent</strong><small>Configure a managed coding session</small></span>
          <em>Draft</em><kbd>ESC</kbd><button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>

        <div className="launch-content">
          <div className="launch-form">
            <fieldset>
              <legend>01 · Agent</legend>
              <div className="agent-options">
                {(['claude', 'codex'] as const).map((option) => {
                  const readiness = runtimeReadiness?.runtimes.find((item) => item.runtime === option);
                  return <button className={agent === option ? 'is-selected' : ''} data-runtime-status={readiness?.status ?? 'checking'} key={option} onClick={() => setAgent(option)} type="button"><span>{option === 'claude' ? '⚡' : '✦'}</span><strong>{option === 'claude' ? 'Claude Code' : 'Codex CLI'}<small>{option} · {option === 'claude' ? 'anthropic' : 'openai'}</small><em>{readiness ? READINESS_LABELS[readiness.status] : readinessFailed ? 'Readiness unavailable' : 'Checking readiness…'}</em></strong></button>;
                })}
              </div>
              <div aria-live="polite" className={`runtime-readiness-detail status-${selectedRuntimeReadiness?.status ?? 'checking'}`}>
                <strong>{selectedRuntimeReadiness ? READINESS_LABELS[selectedRuntimeReadiness.status] : readinessFailed ? 'Readiness unavailable' : 'Checking managed-run readiness…'}</strong>
                <p>{selectedRuntimeReadiness?.reason ?? (readinessFailed ? 'AgentDeck could not inspect this runtime. Existing Session launch remains available.' : 'Inspecting the installed CLI without starting a Run.')}</p>
                {selectedRuntimeReadiness && selectedRuntimeReadiness.capabilities.length > 0 && <div className="runtime-capabilities">{selectedRuntimeReadiness.capabilities.map((item) => <span className={item.supported ? 'is-supported' : 'is-missing'} key={item.capability}><i>{item.supported ? '✓' : '×'}</i><b>{RUNTIME_CAPABILITY_LABELS[item.capability]}</b>{item.reason && <small>{item.reason}</small>}</span>)}</div>}
              </div>
            </fieldset>

            <fieldset>
              <div className="fieldset-heading"><legend>02 · Workspace</legend><div className="segmented-control"><button className={workspaceMode === 'repo' ? 'is-active' : ''} onClick={() => setWorkspaceMode('repo')} type="button">Repository</button><button className={workspaceMode === 'free' ? 'is-active' : ''} onClick={() => setWorkspaceMode('free')} type="button">Free path</button></div></div>
              {workspaceMode === 'repo' ? <select onChange={(event) => setRepoPath(event.target.value)} value={repoPath}>{repos.map((repo) => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}{repo.isDirty ? ' · dirty' : ''}</option>)}</select> : <input onChange={(event) => setFreePath(event.target.value)} placeholder="~/Documents/project" value={freePath} />}
              <div className="launch-two-col"><input onChange={(event) => setName(event.target.value)} placeholder="Session name (optional)" value={name} /><input onChange={(event) => setBranch(event.target.value)} placeholder="Git branch — keep current" value={branch} /></div>
              <label className="checkbox-line"><input checked={createBranch} onChange={(event) => setCreateBranch(event.target.checked)} type="checkbox" /> Create branch if missing <span title="Branch creation is refused when the working tree is dirty">safe checkout</span></label>
            </fieldset>

            <fieldset>
              <legend>03 · Instructions</legend>
              <textarea maxLength={4000} onChange={(event) => setPrompt(event.target.value)} placeholder="Initial objective — injected when the agent is ready" rows={3} value={prompt} />
              <div className="field-hint"><span>Injected when the agent is ready</span><span>{prompt.length} / 4000</span></div>
            </fieldset>

            <fieldset>
              <legend>04 · Permission</legend>
              <div className="permission-options">{PERMISSIONS.map((option) => <button className={permissionMode === option.value ? 'is-selected' : ''} key={option.value} onClick={() => setPermissionMode(option.value)} type="button"><strong>{option.icon} {option.label}</strong><span>{option.description}</span></button>)}</div>
              {permissionMode === 'default' && <div className="permission-note">△ Prompts requiring approval will enter the Attention queue.</div>}
            </fieldset>

            <fieldset>
              <div className="fieldset-heading"><legend>05 · Environment</legend><button className="text-button" onClick={() => envFileRef.current?.click()} type="button">⇪ Import .env</button></div>
              <input accept=".env,text/plain" hidden ref={envFileRef} type="file" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                file.text().then((contents) => setEnvRows(parseEnvFile(contents))).catch(() => setError('Unable to read that .env file.'));
              }} />
              {envRows.map((row, index) => <div className="env-row" key={index}><input aria-label={`Environment key ${index + 1}`} onChange={(event) => updateEnv(index, 'key', event.target.value)} placeholder="KEY" value={row.key} /><input aria-label={`Environment value ${index + 1}`} onChange={(event) => updateEnv(index, 'value', event.target.value)} placeholder="value" value={row.value} /><button aria-label="Remove variable" onClick={() => setEnvRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} type="button">×</button></div>)}
              <button className="add-variable-button" onClick={() => setEnvRows((rows) => [...rows, { key: '', value: '' }])} type="button">＋ Add variable</button>
            </fieldset>
            {error && <div className="form-error">{error}</div>}
          </div>

          <aside className="launch-manifest">
            <div className="micro-heading">Launch manifest</div>
            {manifest.map(([key, value]) => <div className="manifest-row" key={key}><span>{key}</span><strong title={value}>{value}</strong></div>)}
            <hr />
            <div className="micro-heading">Preflight</div>
            {(preflight?.checks ?? [{ label: 'Checking local environment', ok: false }]).map((check) => <div className={`preflight-row${check.ok ? ' is-ok' : ''}`} key={check.label}><span>{check.ok ? '✓' : '·'}</span><strong>{check.label}<small>{check.detail}</small></strong></div>)}
            <hr />
            <div className="micro-heading">Command preview</div>
            <pre className="command-preview">{command.join('\n')}</pre>
            <hr />
            <div className="micro-heading">After launch</div>
            <div className="preflight-row is-ok"><span>✓</span><strong>Open terminal</strong></div>
            <div className="preflight-row is-ok"><span>✓</span><strong>Inject objective</strong></div>
            <p>Local process · nothing leaves this machine.</p>
          </aside>
        </div>

        <footer className="launch-footer">
          <span className={preflight?.ready ? 'is-ready' : ''}><i />{preflight?.ready ? 'Local engine ready — all preflight checks passed' : 'Waiting for valid launch configuration'}</span>
          <button className="button" onClick={onClose} type="button">Cancel</button>
          <button className="button button-primary" disabled={submitting || preflight?.ready === false} onClick={() => void submit()} type="button">{submitting ? 'Initializing…' : 'Initialize session'} <kbd>⌘⏎</kbd></button>
        </footer>
      </section>
    </div>
  );
}
