// Working-tree and branch diffs surfaced in the dashboard's Changes tab.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { git } from './scan.js';

export type DiffMode = 'uncommitted' | 'branch';

export interface DiffFileSummary {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface DiffSummary {
  mode: DiffMode;
  baseBranch?: string;
  files: DiffFileSummary[];
}

export interface FileDiff {
  diff: string;
  truncated: boolean;
}

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Like git() in scan.ts, but tolerates exit code 1 (git diff --no-index uses
 * it for "differences found") and returns partial output when a huge diff
 * overruns maxBuffer, instead of throwing the whole request away.
 */
async function gitDiffOutput(cwd: string, args: string[]): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: MAX_BUFFER_BYTES,
    }, (error, stdout) => {
      if (!error) return resolve({ stdout, truncated: false });
      const { code } = error as { code?: number | string };
      if (code === 1) return resolve({ stdout, truncated: false });
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout: stdout ?? '', truncated: true });
      reject(error);
    });
  });
}

export function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of output.split('\n')) {
    const [additions, deletions, filePath] = line.split('\t');
    if (!filePath || additions === undefined || deletions === undefined) continue;
    const binary = additions === '-' || deletions === '-';
    stats.set(filePath, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return stats;
}

export function parseNameStatus(output: string): Map<string, DiffFileSummary['status']> {
  const statuses = new Map<string, DiffFileSummary['status']>();
  for (const line of output.split('\n')) {
    const [code, ...paths] = line.split('\t');
    const filePath = paths.at(-1);
    if (!code || !filePath) continue;
    const letter = code[0];
    statuses.set(filePath, letter === 'A' || letter === 'D' || letter === 'R' ? letter : 'M');
  }
  return statuses;
}

/** XY porcelain code (e.g. " M", "A ", "??", "R ") → one summary letter. */
export function porcelainStatusLetter(code: string): DiffFileSummary['status'] {
  if (code.startsWith('??')) return '?';
  if (code.includes('R')) return 'R';
  if (code.includes('D')) return 'D';
  if (code.includes('A')) return 'A';
  return 'M';
}

export async function resolveBaseBranch(repoPath: string): Promise<string | undefined> {
  const candidates: string[] = [];
  try {
    const remoteHead = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const short = remoteHead.split('/').slice(1).join('/');
    if (short) candidates.push(short);
  } catch {
    // no origin remote or unset origin/HEAD
  }
  candidates.push('main', 'master');
  for (const candidate of candidates) {
    try {
      await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Resolves a repo-relative file path, rejecting traversal outside the repo. */
export function resolveRepoFile(repoPath: string, filePath: string): string | undefined {
  if (path.isAbsolute(filePath)) return undefined;
  const resolved = path.resolve(repoPath, filePath);
  return resolved.startsWith(path.resolve(repoPath) + path.sep) ? resolved : undefined;
}

async function untrackedNumstat(repoPath: string, filePath: string): Promise<{ additions: number; binary: boolean }> {
  try {
    const { stdout } = await gitDiffOutput(repoPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
    const [additions] = stdout.split('\t');
    const binary = additions === '-';
    return { additions: binary ? 0 : Number(additions) || 0, binary };
  } catch {
    return { additions: 0, binary: false };
  }
}

async function trackedNumstat(repoPath: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
  try {
    return parseNumstat(await git(repoPath, ['diff', 'HEAD', '--no-renames', '--numstat']));
  } catch {
    // A repo without commits has no HEAD; fall back to the index diff.
    return parseNumstat(await git(repoPath, ['diff', '--no-renames', '--numstat']));
  }
}

export async function diffSummary(repoPath: string, mode: DiffMode): Promise<DiffSummary> {
  const baseBranch = await resolveBaseBranch(repoPath);

  if (mode === 'branch') {
    if (!baseBranch) return { mode, files: [] };
    const mergeBase = await git(repoPath, ['merge-base', baseBranch, 'HEAD']);
    const [numstat, nameStatus] = await Promise.all([
      git(repoPath, ['diff', '--no-renames', '--numstat', mergeBase, 'HEAD']),
      git(repoPath, ['diff', '--no-renames', '--name-status', mergeBase, 'HEAD']),
    ]);
    const stats = parseNumstat(numstat);
    const statuses = parseNameStatus(nameStatus);
    const files = [...stats].map(([filePath, stat]) => ({
      path: filePath,
      status: statuses.get(filePath) ?? 'M',
      ...stat,
    }));
    return { mode, baseBranch, files };
  }

  // status --porcelain output is position-sensitive; git() trims stdout and
  // would eat the leading space of the first " M file" line, so use the raw runner.
  const [{ stdout: porcelain }, stats] = await Promise.all([
    gitDiffOutput(repoPath, ['status', '--porcelain']),
    trackedNumstat(repoPath),
  ]);
  const files = await Promise.all(porcelain.split('\n').filter(Boolean).map(async (line) => {
    const code = line.slice(0, 2);
    const filePath = line.slice(3).split(' -> ').at(-1)?.replace(/^"|"$/g, '') ?? '';
    const status = porcelainStatusLetter(code);
    if (status === '?') {
      const { additions, binary } = await untrackedNumstat(repoPath, filePath);
      return { path: filePath, status, additions, deletions: 0, binary } satisfies DiffFileSummary;
    }
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    return { path: filePath, status, ...stat } satisfies DiffFileSummary;
  }));
  const summary: DiffSummary = { mode, files: files.filter((file) => file.path !== '') };
  if (baseBranch) summary.baseBranch = baseBranch;
  return summary;
}

export async function diffFile(repoPath: string, filePath: string, mode: DiffMode): Promise<FileDiff> {
  if (!resolveRepoFile(repoPath, filePath)) throw new Error('path is outside the repository');

  let output: { stdout: string; truncated: boolean };
  if (mode === 'branch') {
    const baseBranch = await resolveBaseBranch(repoPath);
    if (!baseBranch) return { diff: '', truncated: false };
    const mergeBase = await git(repoPath, ['merge-base', baseBranch, 'HEAD']);
    output = await gitDiffOutput(repoPath, ['diff', '--no-renames', mergeBase, 'HEAD', '--', filePath]);
  } else {
    const { stdout: porcelain } = await gitDiffOutput(repoPath, ['status', '--porcelain', '--', filePath]);
    if (porcelain.startsWith('??')) {
      output = await gitDiffOutput(repoPath, ['diff', '--no-index', '--', '/dev/null', filePath]);
    } else {
      try {
        output = await gitDiffOutput(repoPath, ['diff', 'HEAD', '--no-renames', '--', filePath]);
      } catch {
        output = await gitDiffOutput(repoPath, ['diff', '--no-renames', '--', filePath]);
      }
    }
  }

  if (Buffer.byteLength(output.stdout, 'utf8') > MAX_DIFF_BYTES) {
    return { diff: Buffer.from(output.stdout, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
  }
  return { diff: output.stdout, truncated: output.truncated };
}
