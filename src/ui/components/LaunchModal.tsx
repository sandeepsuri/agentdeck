import { useMemo, useState } from 'react';
import type { AgentType, Repo, Session } from '../../types.js';

interface EnvRow {
  key: string;
  value: string;
}

type PermissionMode = 'default' | 'acceptEdits' | 'plan';

const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Auto-edit' },
  { value: 'plan', label: 'Plan' },
];

export interface LaunchModalProps {
  repos: Repo[];
  onClose: () => void;
  onLaunched: (session: Session) => void;
}

export function LaunchModal({ repos, onClose, onLaunched }: LaunchModalProps) {
  const [agent, setAgent] = useState<AgentType>('claude');
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? '');
  const [freePath, setFreePath] = useState('');
  const [useFreePath, setUseFreePath] = useState(repos.length === 0);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [branch, setBranch] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.path === repoPath),
    [repoPath, repos],
  );
  const branchSuggestions = useMemo(
    () =>
      [...new Set([
        selectedRepo?.currentBranch,
        ...(selectedRepo?.worktrees?.map((worktree) => worktree.branch) ?? []),
      ].filter((value): value is string => Boolean(value)))],
    [selectedRepo],
  );

  const updateEnv = (index: number, field: keyof EnvRow, value: string) => {
    setEnvRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  };

  const submit = async () => {
    const cwd = useFreePath ? freePath.trim() : repoPath;
    if (!cwd) {
      setError('Choose a repository or enter a path.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const env = Object.fromEntries(
      envRows
        .map((row) => [row.key.trim(), row.value] as const)
        .filter(([key]) => key.length > 0),
    );
    const body: Record<string, unknown> = { agent, cwd };
    if (name.trim()) body.name = name.trim();
    if (prompt.trim()) body.initialPrompt = prompt;
    body.permissionMode = permissionMode;
    if (branch.trim()) body.branch = branch.trim();
    if (Object.keys(env).length > 0) body.env = env;
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json() as Session & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      onLaunched(data);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Launch session"
        aria-modal="true"
        role="dialog"
        style={styles.modal}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header style={styles.header}>
          <h2 style={styles.title}>Launch agent</h2>
          <button aria-label="Close" onClick={onClose} style={styles.ghostButton}>×</button>
        </header>

        <label style={styles.label}>Agent</label>
        <div style={styles.radioRow}>
          {(['claude', 'codex'] as const).map((option) => (
            <label key={option} style={styles.radioLabel}>
              <input
                checked={agent === option}
                name="agent"
                onChange={() => setAgent(option)}
                type="radio"
              />
              {option}
            </label>
          ))}
        </div>

        <label style={styles.label}>Working directory</label>
        <div style={styles.modeRow}>
          <button onClick={() => setUseFreePath(false)} style={useFreePath ? styles.modeButton : styles.modeActive}>Repository</button>
          <button onClick={() => setUseFreePath(true)} style={useFreePath ? styles.modeActive : styles.modeButton}>Free path</button>
        </div>
        {useFreePath ? (
          <input value={freePath} onChange={(event) => setFreePath(event.target.value)} placeholder="~/Documents/project" style={styles.input} />
        ) : (
          <select value={repoPath} onChange={(event) => setRepoPath(event.target.value)} style={styles.input}>
            {repos.map((repo) => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}
          </select>
        )}

        <div style={styles.twoColumns}>
          <label style={styles.field}>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional label" style={styles.input} /></label>
          <label style={styles.field}>Existing branch<input list="launch-branches" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Keep current" style={styles.input} /></label>
          <datalist id="launch-branches">{branchSuggestions.map((item) => <option key={item} value={item} />)}</datalist>
        </div>
        <label style={styles.field}>Initial prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} style={{ ...styles.input, resize: 'vertical' }} /></label>
        <label style={styles.label}>Permission mode</label>
        <div style={styles.modeRow}>
          {PERMISSION_MODES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setPermissionMode(value)}
              style={permissionMode === value ? styles.modeActive : styles.modeButton}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={styles.envHeader}>
          <span>Environment</span>
          <button onClick={() => setEnvRows((rows) => [...rows, { key: '', value: '' }])} style={styles.ghostButton}>+ variable</button>
        </div>
        {envRows.map((row, index) => (
          <div key={index} style={styles.envRow}>
            <input aria-label={`Environment key ${index + 1}`} value={row.key} onChange={(event) => updateEnv(index, 'key', event.target.value)} placeholder="KEY" style={styles.input} />
            <input aria-label={`Environment value ${index + 1}`} value={row.value} onChange={(event) => updateEnv(index, 'value', event.target.value)} placeholder="value" style={styles.input} />
            <button aria-label="Remove environment variable" onClick={() => setEnvRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} style={styles.ghostButton}>×</button>
          </div>
        ))}

        <label style={styles.disabledOption} title="Worktree creation is planned for v0.2">
          <input disabled type="checkbox" /> Create a new worktree (coming in v0.2)
        </label>
        {error && <div style={styles.error}>{error}</div>}
        <footer style={styles.footer}>
          <button onClick={onClose} style={styles.secondaryButton}>Cancel</button>
          <button disabled={submitting} onClick={() => void submit()} style={styles.primaryButton}>{submitting ? 'Launching…' : 'Launch'}</button>
        </footer>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,.68)', display: 'grid', placeItems: 'center', padding: 24 },
  modal: { width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: '#11161d', border: '1px solid #303844', borderRadius: 12, boxShadow: '0 24px 80px rgba(0,0,0,.5)', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontSize: 18 },
  label: { color: '#9da8b5', fontSize: 12, marginTop: 4 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, color: '#9da8b5', fontSize: 12 },
  radioRow: { display: 'flex', gap: 18 },
  radioLabel: { display: 'flex', alignItems: 'center', gap: 6, textTransform: 'capitalize' },
  modeRow: { display: 'flex', gap: 6 },
  modeButton: { background: '#171d25', border: '1px solid #303844', color: '#9da8b5', borderRadius: 5, padding: '5px 9px', cursor: 'pointer' },
  modeActive: { background: '#214b80', border: '1px solid #3677bd', color: '#fff', borderRadius: 5, padding: '5px 9px', cursor: 'pointer' },
  input: { boxSizing: 'border-box', width: '100%', background: '#0b0f14', border: '1px solid #303844', color: '#e6edf3', borderRadius: 6, padding: '8px 10px', font: 'inherit' },
  twoColumns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  envHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#9da8b5', fontSize: 12 },
  envRow: { display: 'grid', gridTemplateColumns: '1fr 1.5fr auto', gap: 6 },
  ghostButton: { background: 'transparent', border: 0, color: '#9da8b5', cursor: 'pointer', font: 'inherit' },
  disabledOption: { color: '#606b78', fontSize: 12, marginTop: 4 },
  error: { color: '#ff7b72', fontSize: 12, whiteSpace: 'pre-wrap' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  secondaryButton: { background: '#1b222c', border: '1px solid #303844', color: '#d8dee4', borderRadius: 6, padding: '8px 14px', cursor: 'pointer' },
  primaryButton: { background: '#238636', border: '1px solid #2ea043', color: '#fff', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' },
};
