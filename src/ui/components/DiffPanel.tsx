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
  M: { color: '#d29922', label: 'modified' },
  A: { color: '#3fb950', label: 'added' },
  D: { color: '#f85149', label: 'deleted' },
  R: { color: '#58a6ff', label: 'renamed' },
  '?': { color: '#8b949e', label: 'untracked' },
};

function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: '#8b949e' };
  if (line.startsWith('@@')) return { color: '#58a6ff', background: '#101b2c' };
  if (line.startsWith('+')) return { color: '#7ee787', background: '#0d2416' };
  if (line.startsWith('-')) return { color: '#ffa198', background: '#2a0f12' };
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return { color: '#697586' };
  }
  return { color: '#c9d1d9' };
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
            {' '}<span style={{ color: '#3fb950' }}>+{totals.additions}</span>
            {' '}<span style={{ color: '#f85149' }}>−{totals.deletions}</span>
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
                {file.binary ? 'binary' : <><span style={{ color: '#3fb950' }}>+{file.additions}</span> <span style={{ color: '#f85149' }}>−{file.deletions}</span></>}
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
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: '1px solid #242b35' },
  modeToggle: { display: 'flex', border: '1px solid #303844', borderRadius: 5, overflow: 'hidden' },
  modeButton: { border: 0, background: '#111820', color: '#8b949e', padding: '5px 10px', cursor: 'pointer', font: 'inherit', fontSize: 11 },
  modeActive: { background: '#1c2a3d', color: '#cde3f8' },
  totals: { color: '#8b949e', fontSize: 11, whiteSpace: 'nowrap' },
  fileList: { flex: 1, minHeight: 0, overflowY: 'auto' },
  fileRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid #171d25', cursor: 'pointer' },
  statusLetter: { width: 14, fontWeight: 700, fontSize: 11, flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  filePath: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', fontSize: 12 },
  fileCounts: { fontSize: 11, whiteSpace: 'nowrap', color: '#8b949e' },
  chevron: { color: '#697586', fontSize: 10, width: 12, textAlign: 'center' },
  diffNotice: { padding: '10px 12px', color: '#697586', fontSize: 11 },
  truncated: { padding: '6px 12px', color: '#d29922', background: '#241d0b', fontSize: 11 },
  diffBody: { borderBottom: '1px solid #242b35', background: '#0a0e13', maxHeight: '45vh', overflow: 'auto' },
  diffPre: { margin: 0, padding: '6px 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.5, minWidth: 'fit-content' },
  diffLine: { padding: '0 12px', whiteSpace: 'pre' },
};
