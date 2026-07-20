import { useCallback, useEffect, useMemo, useState } from 'react';

type DiffMode = 'uncommitted' | 'branch';

interface DiffFileSummary {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  additions: number;
  deletions: number;
  binary?: boolean;
}

interface DiffSummary {
  mode: DiffMode;
  baseBranch?: string;
  files: DiffFileSummary[];
}

interface FileDiff {
  diff: string;
  truncated: boolean;
}

const STATUS_STYLE: Record<DiffFileSummary['status'], { color: string; label: string }> = {
  M: { color: 'var(--status-waiting)', label: 'modified' },
  A: { color: 'var(--status-working)', label: 'added' },
  D: { color: 'var(--status-error)', label: 'deleted' },
  R: { color: 'var(--status-starting)', label: 'renamed' },
  '?': { color: 'var(--text-muted)', label: 'untracked' },
};

function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: 'var(--text-muted)' };
  if (line.startsWith('@@')) return { color: 'var(--diff-hunk-text)', background: 'var(--diff-hunk-bg)' };
  if (line.startsWith('+')) return { color: 'var(--diff-add-text)', background: 'var(--diff-add-bg)' };
  if (line.startsWith('-')) return { color: 'var(--diff-delete-text)', background: 'var(--diff-delete-bg)' };
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return { color: 'var(--text-muted)' };
  }
  return { color: 'var(--text-secondary)' };
}

function FileDiffView({ repoPath, file, mode }: { repoPath: string; file: DiffFileSummary; mode: DiffMode }) {
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [failed, setFailed] = useState(false);
  // refetch when the summary's counts for this file change (agent kept editing)
  const statKey = `${file.additions}-${file.deletions}-${file.status}`;

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ repo: repoPath, path: file.path, mode });
    fetch(`/api/repos/diff/file?${query}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('fetch failed')))
      .then((body: FileDiff) => { if (!cancelled) { setFileDiff(body); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [repoPath, file.path, mode, statKey]);

  if (failed) return <div style={styles.diffNotice}>Could not load this diff.</div>;
  if (!fileDiff) return <div style={styles.diffNotice}>Loading diff…</div>;
  if (file.binary || fileDiff.diff === '') return <div style={styles.diffNotice}>{file.binary ? 'Binary file.' : 'No textual changes.'}</div>;
  return (
    <div style={styles.diffBody}>
      {fileDiff.truncated && <div style={styles.truncated}>Diff truncated — showing the first 512 KB.</div>}
      <pre style={styles.diffPre}>
        {fileDiff.diff.split('\n').map((line, index) => (
          <div key={index} style={{ ...styles.diffLine, ...lineStyle(line) }}>{line || ' '}</div>
        ))}
      </pre>
    </div>
  );
}

export function DiffPanel({ repoPath, onCount }: { repoPath: string; onCount?: (count: number) => void }) {
  const [mode, setMode] = useState<DiffMode>('uncommitted');
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    const query = new URLSearchParams({ repo: repoPath, mode });
    fetch(`/api/repos/diff?${query}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('fetch failed')))
      .then((body: DiffSummary) => { setSummary(body); setError(null); })
      .catch(() => setError('Could not load changes for this repository.'));
  }, [repoPath, mode]);

  useEffect(() => {
    setSummary(null);
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    if (summary && summary.mode === 'uncommitted') onCount?.(summary.files.length);
  }, [summary, onCount]);

  const totals = useMemo(() => (summary?.files ?? []).reduce(
    (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  ), [summary]);

  const toggle = (filePath: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  return (
    <div style={styles.panel}>
      <div style={styles.toolbar}>
        <div style={styles.modeToggle}>
          <button
            onClick={() => setMode('uncommitted')}
            style={{ ...styles.modeButton, ...(mode === 'uncommitted' ? styles.modeActive : {}) }}
          >Uncommitted</button>
          {summary?.baseBranch !== undefined && (
            <button
              onClick={() => setMode('branch')}
              style={{ ...styles.modeButton, ...(mode === 'branch' ? styles.modeActive : {}) }}
            >vs {summary.baseBranch}</button>
          )}
        </div>
        {summary && (
          <span style={styles.totals}>
            {summary.files.length} file{summary.files.length === 1 ? '' : 's'}
            {' '}<span style={{ color: 'var(--status-working)' }}>+{totals.additions}</span>
            {' '}<span style={{ color: 'var(--status-error)' }}>−{totals.deletions}</span>
          </span>
        )}
      </div>

      {error && <div style={styles.diffNotice}>{error}</div>}
      {!error && summary === null && <div style={styles.diffNotice}>Loading changes…</div>}
      {!error && summary !== null && summary.files.length === 0 && (
        <div style={styles.diffNotice}>
          {mode === 'uncommitted' ? 'The working tree is clean.' : `No commits ahead of ${summary.baseBranch ?? 'the base branch'}.`}
        </div>
      )}

      <div style={styles.fileList}>
        {(summary?.files ?? []).map((file) => (
          <div key={file.path}>
            <div onClick={() => toggle(file.path)} style={styles.fileRow}>
              <span style={{ ...styles.statusLetter, color: STATUS_STYLE[file.status].color }} title={STATUS_STYLE[file.status].label}>
                {file.status}
              </span>
              <span style={styles.filePath} title={file.path}>{file.path}</span>
              <span style={styles.fileCounts}>
                {file.binary ? 'binary' : <><span style={{ color: 'var(--status-working)' }}>+{file.additions}</span> <span style={{ color: 'var(--status-error)' }}>−{file.deletions}</span></>}
              </span>
              <span style={styles.chevron}>{expanded.has(file.path) ? '▾' : '▸'}</span>
            </div>
            {expanded.has(file.path) && <FileDiffView file={file} mode={mode} repoPath={repoPath} />}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-muted)' },
  modeToggle: { display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 4, overflow: 'hidden' },
  modeButton: { border: 0, background: 'var(--surface-input)', color: 'var(--text-secondary)', padding: '5px 10px', cursor: 'pointer', font: 'inherit', fontSize: 11 },
  modeActive: { background: 'var(--surface-selected)', color: 'var(--text-primary)', boxShadow: 'inset 0 -2px var(--border-selection)' },
  totals: { color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap', fontFamily: '"JetBrains Mono", ui-monospace, monospace' },
  fileList: { flex: 1, minHeight: 0, overflowY: 'auto' },
  fileRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--border-muted)', cursor: 'pointer' },
  statusLetter: { width: 14, fontWeight: 700, fontSize: 11, flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  filePath: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', fontSize: 12 },
  fileCounts: { fontSize: 11, whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontFamily: '"JetBrains Mono", ui-monospace, monospace' },
  chevron: { color: 'var(--text-muted)', fontSize: 10, width: 12, textAlign: 'center' },
  diffNotice: { padding: '10px 12px', color: 'var(--text-muted)', fontSize: 11 },
  truncated: { padding: '6px 12px', color: 'var(--warning)', background: 'var(--status-waiting-bg)', fontSize: 11 },
  diffBody: { borderBottom: '1px solid var(--border-muted)', background: 'var(--surface-code)', maxHeight: '45vh', overflow: 'auto' },
  diffPre: { margin: 0, padding: '6px 0', fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.5, minWidth: 'fit-content' },
  diffLine: { padding: '0 12px', whiteSpace: 'pre' },
};
