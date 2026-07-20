import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileClaim, Session } from '../../types.js';
import { PublishModal, type PublishMode } from '../components/PublishModal.js';
import { sessionLabel } from './model.js';

type DiffMode = 'uncommitted' | 'branch';
type DiffLayout = 'unified' | 'split';

interface DiffFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  additions: number;
  deletions: number;
  binary?: boolean;
  indexStatus?: 'M' | 'A' | 'D' | 'R';
  worktreeStatus?: 'M' | 'A' | 'D' | 'R' | '?';
  staged?: boolean;
  partiallyStaged?: boolean;
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
  const [stagedCount, setStagedCount] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileActionPath, setFileActionPath] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [publishMode, setPublishMode] = useState<PublishMode | null>(null);

  const refresh = useCallback(() => {
    if (!repoPath) {
      setSummary({ files: [] });
      setStagedCount(0);
      return;
    }
    const requestSummary = (requestedMode: DiffMode) => {
      const query = new URLSearchParams({ repo: repoPath, mode: requestedMode });
      return fetch(`/api/repos/diff?${query}`)
        .then((response) => response.ok ? response.json() as Promise<Summary> : Promise.reject(new Error('Unable to load repository changes.')));
    };
    const visibleSummary = requestSummary(mode);
    const worktreeSummary = mode === 'uncommitted' ? visibleSummary : requestSummary('uncommitted');
    Promise.all([visibleSummary, worktreeSummary])
      .then(([body, worktree]) => {
        setSummary(body);
        setStagedCount(worktree.files.filter((file) => file.staged).length);
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

  const fileAction = async (filePath: string, action: 'stage' | 'unstage' | 'discard') => {
    if (!repoPath) return;
    if (action === 'discard' && !window.confirm(`Discard all uncommitted changes in ${filePath}?`)) return;
    setFileActionPath(filePath);
    try {
      const response = await fetch('/api/repos/file-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: repoPath, path: filePath, action }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) return onError(body.error ?? `Unable to ${action} file.`);
      refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileActionPath(null);
    }
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

  const fileGroups = mode === 'branch'
    ? [
      { label: 'Modified', files: summary.files.filter((file) => file.status !== '?') },
      { label: 'Untracked', files: summary.files.filter((file) => file.status === '?') },
    ]
    : [
      { label: 'Staged', files: summary.files.filter((file) => file.staged && !file.partiallyStaged) },
      { label: 'Partially staged', files: summary.files.filter((file) => file.partiallyStaged) },
      { label: 'Unstaged', files: summary.files.filter((file) => !file.staged) },
    ];
  return <>
    <section className="changes-workspace">
      <header className="changes-workspace-header">
        <span><strong>Changes</strong><small>{summary.files.length} file{summary.files.length === 1 ? '' : 's'} · {stagedCount} staged</small></span>
        <div className="diff-publish-actions"><button className="button" disabled={stagedCount === 0} onClick={() => setPublishMode('commit')} type="button">Commit staged</button><button className="button button-primary" onClick={() => setPublishMode('pr')} type="button">Create PR</button></div>
      </header>
      <div className="changes-workspace-body">
        <aside className="change-files-rail">
        <div className="change-scope segmented-control">
          <button className={mode === 'uncommitted' ? 'is-active' : ''} onClick={() => setMode('uncommitted')} type="button">Worktree · {summary.files.length}</button>
          <button className={mode === 'branch' ? 'is-active' : ''} onClick={() => setMode('branch')} type="button">vs {summary.baseBranch ?? 'main'}</button>
        </div>
        <div className="change-file-scroll">
          {fileGroups.map((group) => (
              <div key={group.label}>
                <div className="sidebar-section-label"><span>{group.label}</span><span>{group.files.length}</span></div>
                {group.files.map((file) => (
                  <div className={`change-file-row${file.path === selectedPath ? ' is-selected' : ''}${mode === 'branch' ? ' is-readonly' : ''}`} key={file.path}>
                    {mode === 'uncommitted' && <button
                      aria-checked={file.partiallyStaged ? 'mixed' : Boolean(file.staged)}
                      aria-label={`${file.staged ? 'Unstage' : 'Stage'} ${file.path}`}
                      className={`change-stage-checkbox${file.staged ? ' is-checked' : ''}${file.partiallyStaged ? ' is-mixed' : ''}`}
                      disabled={fileActionPath === file.path}
                      onClick={() => void fileAction(file.path, file.staged ? 'unstage' : 'stage')}
                      role="checkbox"
                      type="button"
                    >{fileActionPath === file.path ? '·' : file.partiallyStaged ? '−' : file.staged ? '✓' : ''}</button>}
                    <button className="change-file-select" onClick={() => setSelectedPath(file.path)} type="button">
                      <span title={file.path}>{file.path}</span>
                      {file.staged && <em>{file.partiallyStaged ? 'Partial' : 'Staged'}</em>}
                      <small><b>+{file.additions}</b> <i>−{file.deletions}</i></small>
                      <span className="change-density"><i /><i /><i /><i /><i /><i /></span>
                    </button>
                  </div>
                ))}
              </div>
          ))}
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
          <div className="diff-path"><span>{repoPath.split('/').pop()} /</span><strong>{selectedPath ?? 'No file selected'}</strong>{selected && <em>{selected.partiallyStaged ? 'Partial' : selected.staged ? 'Staged' : selected.status === '?' ? 'Untracked' : 'Modified'}</em>}</div>
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
          <button className="button" disabled={!selected || mode !== 'uncommitted' || fileActionPath === selectedPath} onClick={() => selectedPath && void fileAction(selectedPath, selected?.staged ? 'unstage' : 'stage')} type="button">{selected?.staged ? '✓ Staged — unstage' : 'Stage file'}</button>
          <button className="button danger-button" disabled={!selected || mode !== 'uncommitted' || fileActionPath === selectedPath} onClick={() => selectedPath && void fileAction(selectedPath, 'discard')} type="button">Discard</button>
          <button className={`button button-primary${reviewed.has(selectedPath ?? '') ? ' is-reviewed' : ''}`} disabled={!selected} onClick={() => selectedPath && setReviewed((current) => {
            const next = new Set(current);
            if (next.has(selectedPath)) next.delete(selectedPath); else next.add(selectedPath);
            return next;
          })} type="button">{reviewed.has(selectedPath ?? '') ? '✓ Reviewed' : 'Review changes'}</button>
          </footer>
        </div>
      </div>
    </section>
    {publishMode && <PublishModal initialMode={publishMode} onChanged={refresh} onClose={() => setPublishMode(null)} repoPath={repoPath} />}
  </>;
}
