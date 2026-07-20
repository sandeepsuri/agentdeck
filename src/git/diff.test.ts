import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFile, diffSummary, parseNameStatus, parseNumstat, porcelainStatusLetter, resolveRepoFile } from './diff.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-diff-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'agentdeck@example.test');
  git(dir, 'config', 'user.name', 'AgentDeck Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\ntwo\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
  git(dir, 'branch', '-M', 'main');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseNumstat', () => {
  it('parses counts and flags binary files', () => {
    const stats = parseNumstat('3\t1\tsrc/app.ts\n-\t-\tlogo.png\n');
    expect(stats.get('src/app.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get('logo.png')).toEqual({ additions: 0, deletions: 0, binary: true });
  });
});

describe('parseNameStatus', () => {
  it('maps letters and keeps the rename target path', () => {
    const statuses = parseNameStatus('M\ta.ts\nA\tb.ts\nD\tc.ts\nR100\told.ts\tnew.ts\n');
    expect(statuses.get('a.ts')).toBe('M');
    expect(statuses.get('b.ts')).toBe('A');
    expect(statuses.get('c.ts')).toBe('D');
    expect(statuses.get('new.ts')).toBe('R');
  });
});

describe('porcelainStatusLetter', () => {
  it('collapses XY codes into one letter', () => {
    expect(porcelainStatusLetter('??')).toBe('?');
    expect(porcelainStatusLetter(' M')).toBe('M');
    expect(porcelainStatusLetter('A ')).toBe('A');
    expect(porcelainStatusLetter(' D')).toBe('D');
    expect(porcelainStatusLetter('R ')).toBe('R');
  });
});

describe('resolveRepoFile', () => {
  it('rejects absolute paths and traversal outside the repo', () => {
    expect(resolveRepoFile('/repo', 'src/app.ts')).toBe(path.resolve('/repo/src/app.ts'));
    expect(resolveRepoFile('/repo', '/etc/passwd')).toBeUndefined();
    expect(resolveRepoFile('/repo', '../../etc/passwd')).toBeUndefined();
  });
});

describe('diffSummary', () => {
  it('reports modified and untracked working-tree files with counts', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'one\nchanged\nthree\n');
    fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'a\nb\n');

    const summary = await diffSummary(repoPath, 'uncommitted');
    expect(summary.baseBranch).toBe('main');
    expect(summary.files).toContainEqual({ path: 'README.md', status: 'M', additions: 2, deletions: 1, binary: false });
    expect(summary.files).toContainEqual({ path: 'notes.txt', status: '?', additions: 2, deletions: 0, binary: false });
  });

  it('reports committed branch changes against the base branch', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    git(repoPath, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(repoPath, 'feature.ts'), 'export const x = 1;\n');
    git(repoPath, 'add', 'feature.ts');
    git(repoPath, 'commit', '-m', 'feature work');

    const summary = await diffSummary(repoPath, 'branch');
    expect(summary.baseBranch).toBe('main');
    expect(summary.files).toEqual([
      { path: 'feature.ts', status: 'A', additions: 1, deletions: 0, binary: false },
    ]);
  });
});

describe('diffFile', () => {
  it('returns unified diffs for tracked and untracked files', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'one\nchanged\n');
    fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'brand new\n');

    const tracked = await diffFile(repoPath, 'README.md', 'uncommitted');
    expect(tracked.truncated).toBe(false);
    expect(tracked.diff).toContain('-two');
    expect(tracked.diff).toContain('+changed');

    const untracked = await diffFile(repoPath, 'notes.txt', 'uncommitted');
    expect(untracked.diff).toContain('+brand new');
  });

  it('rejects paths outside the repository', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    await expect(diffFile(repoPath, '../outside.txt', 'uncommitted')).rejects.toThrow(/outside/);
  });

  it('can hide whitespace-only changes', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'one\n  two\n');

    expect((await diffFile(repoPath, 'README.md', 'uncommitted')).diff).not.toBe('');
    expect((await diffFile(repoPath, 'README.md', 'uncommitted', true)).diff).toBe('');
  });
});
