import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileClaim, Session } from '../../types.js';
import { sessionLabel } from './model.js';

type DiffMode = 'uncommitted' | 'branch';
type DiffLayout = 'unified' | 'split';

interface DiffFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  additions: number;
  deletions: number;
  binary?: boolean;
}

interface Summary {
  files: DiffFile[];
  baseBranch?: string;
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'is-addition';
  if (line.startsWith('-') && !line.startsWith('---')) return 'is-deletion';
  if (/^(diff |index |---|\+\+\+)/.test(line)) return 'is-meta';
  return 'is-context';
}

export function ChangesWorkspace({ repoPath, sessions, claims, onError }: {
  repoPath: string | null;
  sessions: Session[];
  claims: FileClaim[];
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<DiffMode>('uncommitted');
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [summary, setSummary] = useState<Summary>({ files: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    if (!repoPath) return setSummary({ files: [] });
    const query = new URLSearchParams({ repo: repoPath, mode });
    fetch(`/api/repos/diff?${query}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load repository changes.')))
      .then((body: Summary) => {
        setSummary(body);
        setSelectedPath((current) => current && body.files.some((file) => file.path === current) ? current : body.files[0]?.path ?? null);
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [mode, onError, repoPath]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    if (!repoPath || !selectedPath) return setDiff('');
    setLoading(true);
    const query = new URLSearchParams({ repo: repoPath, mode, path: selectedPath, ignoreWhitespace: String(ignoreWhitespace) });
    fetch(`/api/repos/diff/file?${query}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load this file.')))
      .then((body: { diff?: string }) => setDiff(body.diff ?? ''))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
  }, [mode, onError, repoPath, selectedPath, ignoreWhitespace]);

  const selected = summary.files.find((file) => file.path === selectedPath) ?? null;
  const selectedIndex = selected ? summary.files.indexOf(selected) : -1;
  const totals = useMemo(() => summary.files.reduce((current, file) => ({
    additions: current.additions + file.additions,
    deletions: current.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [summary.files]);
  const repoClaims = claims.filter((claim) => claim.repo === repoPath);

  const fileAction = async (action: 'stage' | 'unstage' | 'discard') => {
    if (!repoPath || !selectedPath) return;
    if (action === 'discard' && !window.confirm(`Discard all uncommitted changes in ${selectedPath}?`)) return;
    const response = await fetch('/api/repos/file-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: repoPath, path: selectedPath, action }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) return onError(body.error ?? `Unable to ${action} file.`);
    setStaged((current) => {
      const next = new Set(current);
      if (action === 'stage') next.add(selectedPath);
      if (action === 'unstage' || action === 'discard') next.delete(selectedPath);
      return next;
    });
    refresh();
  };

  const openInEditor = async () => {
    if (!repoPath || !selectedPath) return;
    const response = await fetch('/api/repos/open-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: repoPath, path: selectedPath }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) onError(body.error ?? 'Unable to open this file in the editor.');
  };

  if (!repoPath) return <div className="empty-workspace"><strong>Select a repository session</strong><span>Working-tree and branch changes will appear here.</span></div>;

  return (
    <section className="changes-workspace">
      <aside className="change-files-rail">
        <div className="change-scope segmented-control">
          <button className={mode === 'uncommitted' ? 'is-active' : ''} onClick={() => setMode('uncommitted')} type="button">Worktree · {summary.files.length}</button>
          <button className={mode === 'branch' ? 'is-active' : ''} onClick={() => setMode('branch')} type="button">vs {summary.baseBranch ?? 'main'}</button>
        </div>
        <div className="change-file-scroll">
          {(['modified', 'untracked'] as const).map((group) => {
            const files = summary.files.filter((file) => group === 'untracked' ? file.status === '?' : file.status !== '?');
            return (
              <div key={group}>
                <div className="sidebar-section-label"><span>{group}</span><span>{files.length}</span></div>
                {files.map((file) => (
                  <button className={`change-file-row${file.path === selectedPath ? ' is-selected' : ''}`} key={file.path} onClick={() => setSelectedPath(file.path)} type="button">
                    <span title={file.path}>{file.path}</span>
                    {staged.has(file.path) && <em>Staged</em>}
                    <small><b>+{file.additions}</b> <i>−{file.deletions}</i></small>
                    <span className="change-density"><i /><i /><i /><i /><i /><i /></span>
                  </button>
                ))}
              </div>
            );
          })}
          <div className="sidebar-section-label claim-heading"><span>Agent claims</span><span>{repoClaims.length}</span></div>
          {repoClaims.map((claim) => (
            <div className="claim-row" key={`${claim.agent}-${claim.file}`}>
              <span className="claim-dot" />
              <span><strong>{sessions.find((session) => session.agentSessionId === claim.agent)?.name ?? claim.agent}</strong><small>{claim.file}</small></span>
              <em>{claim.agent.slice(0, 2).toUpperCase()}</em>
            </div>
          ))}
        </div>
        <button className="button open-editor-button" disabled={!selectedPath} onClick={() => void openInEditor()} type="button">Open in editor ↗</button>
      </aside>

      <div className="diff-stage">
        <header className="diff-stage-header">
          <div className="diff-path"><span>{repoPath.split('/').pop()} /</span><strong>{selectedPath ?? 'No file selected'}</strong>{selected && <em>{selected.status === '?' ? 'Untracked' : 'Modified'}</em>}</div>
          <div className="diff-toolbar">
            <div className="segmented-control">
              <button className={layout === 'unified' ? 'is-active' : ''} onClick={() => setLayout('unified')} type="button">Unified</button>
              <button className={layout === 'split' ? 'is-active' : ''} onClick={() => setLayout('split')} type="button">Split</button>
            </div>
            <label className="toggle-control"><input checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} type="checkbox" /><span />Ignore whitespace</label>
            <div className="file-pager">
              <button disabled={selectedIndex < 1} onClick={() => setSelectedPath(summary.files[selectedIndex - 1]?.path ?? null)} type="button">‹ Prev</button>
              <span>{selectedIndex >= 0 ? selectedIndex + 1 : 0} / {summary.files.length} files</span>
              <button disabled={selectedIndex < 0 || selectedIndex >= summary.files.length - 1} onClick={() => setSelectedPath(summary.files[selectedIndex + 1]?.path ?? null)} type="button">Next ›</button>
            </div>
          </div>
        </header>
        <div className={`diff-code-view is-${layout}`}>
          {loading && <div className="diff-empty">Loading changes…</div>}
          {!loading && !selected && <div className="diff-empty">The selected scope contains no changes.</div>}
          {!loading && selected?.binary && <div className="diff-empty">Binary file changed.</div>}
          {!loading && selected && !selected.binary && diff.split('\n').map((line, index) => (
            <div className={`diff-code-line ${lineClass(line)}`} key={`${index}-${line}`}>
              <span>{line.startsWith('@@') ? '' : index + 1}</span>
              <span>{line.startsWith('@@') ? '' : index + 1}</span>
              <code>{line || ' '}</code>
              {layout === 'split' && <code>{line.startsWith('-') ? ' ' : line || ' '}</code>}
            </div>
          ))}
        </div>
        <footer className="diff-footer">
          <span>💬 0 comments · <b>+{selected?.additions ?? 0}</b> <i>−{selected?.deletions ?? 0}</i></span>
          <span className="diff-footer-totals">Repository +{totals.additions} −{totals.deletions}</span>
          <button className="button" disabled={!selected} onClick={() => void fileAction(staged.has(selectedPath ?? '') ? 'unstage' : 'stage')} type="button">{staged.has(selectedPath ?? '') ? '✓ Staged — unstage' : 'Stage file'}</button>
          <button className="button danger-button" disabled={!selected} onClick={() => void fileAction('discard')} type="button">Discard</button>
          <button className={`button button-primary${reviewed.has(selectedPath ?? '') ? ' is-reviewed' : ''}`} disabled={!selected} onClick={() => selectedPath && setReviewed((current) => {
            const next = new Set(current);
            if (next.has(selectedPath)) next.delete(selectedPath); else next.add(selectedPath);
            return next;
          })} type="button">{reviewed.has(selectedPath ?? '') ? '✓ Reviewed' : 'Review changes'}</button>
        </footer>
      </div>
    </section>
  );
}
