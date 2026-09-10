import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRunCommit, observeRunChanges } from './delivery.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-delivery-'));
  tempDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(): string {
  const repo = tempDir();
  // Plain `git init` (never `-b main`, unsupported before Git 2.28) then a
  // symbolic-ref rewrite before the first commit — portable across whatever
  // Git happens to be first on PATH, unlike relying on init.defaultBranch.
  git(repo, 'init');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.email', 'human@example.test');
  git(repo, 'config', 'user.name', 'A Human');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'fixture');
  return repo;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('observeRunChanges', () => {
  it('reports task output while excluding AgentDeck coordination metadata', async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, '.agents'));
    fs.writeFileSync(path.join(repo, '.agents', 'bus.jsonl'), '{}\n');
    fs.writeFileSync(path.join(repo, 'SUMMARY.md'), '# Summary\n');

    await expect(observeRunChanges(repo)).resolves.toEqual(['SUMMARY.md']);
  });
});

describe('applyRunCommit', () => {
  it('fast-forwards the selected clean checkout so task files appear in the Repository', async () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(repo, 'worktree', 'add', '-b', 'agentdeck/run/one', worktree, base);
    fs.writeFileSync(path.join(worktree, 'SUMMARY.md'), '# Summary\n');
    git(worktree, 'add', 'SUMMARY.md');
    git(worktree, 'commit', '-m', 'summary');
    const commit = git(worktree, 'rev-parse', 'HEAD');

    await expect(applyRunCommit({
      repositoryPath: repo, targetBranch: 'main', expectedBaseCommit: base, commit,
    })).resolves.toEqual({ kind: 'applied', repositoryPath: repo, branch: 'main' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(commit);
    expect(fs.readFileSync(path.join(repo, 'SUMMARY.md'), 'utf8')).toBe('# Summary\n');
  });

  it('leaves the checkout untouched when uncommitted work collides with the Run commit', async () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(repo, 'worktree', 'add', '-b', 'agentdeck/run/two', worktree, base);
    fs.writeFileSync(path.join(worktree, 'SUMMARY.md'), '# Summary\n');
    git(worktree, 'add', 'SUMMARY.md');
    git(worktree, 'commit', '-m', 'summary');
    const commit = git(worktree, 'rev-parse', 'HEAD');
    // The same path the Run commit adds — a fast-forward would overwrite it.
    fs.writeFileSync(path.join(repo, 'SUMMARY.md'), 'mine\n');

    const result = await applyRunCommit({
      repositoryPath: repo, targetBranch: 'main', expectedBaseCommit: base, commit,
    });

    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' ? result.reason : '').toContain('SUMMARY.md');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(fs.readFileSync(path.join(repo, 'SUMMARY.md'), 'utf8')).toBe('mine\n');
  });

  it('applies over unrelated untracked files instead of vetoing the whole result', async () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(repo, 'worktree', 'add', '-b', 'agentdeck/run/three', worktree, base);
    fs.writeFileSync(path.join(worktree, 'SUMMARY.md'), '# Summary\n');
    git(worktree, 'add', 'SUMMARY.md');
    git(worktree, 'commit', '-m', 'summary');
    const commit = git(worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'local.txt'), 'mine\n');

    await expect(applyRunCommit({
      repositoryPath: repo, targetBranch: 'main', expectedBaseCommit: base, commit,
    })).resolves.toEqual({ kind: 'applied', repositoryPath: repo, branch: 'main' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(commit);
    expect(fs.readFileSync(path.join(repo, 'SUMMARY.md'), 'utf8')).toBe('# Summary\n');
    expect(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8')).toBe('mine\n');
  });

  it('preserves a local edit to a tracked file the Run commit never touches', async () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(repo, 'worktree', 'add', '-b', 'agentdeck/run/four', worktree, base);
    fs.writeFileSync(path.join(worktree, 'SUMMARY.md'), '# Summary\n');
    git(worktree, 'add', 'SUMMARY.md');
    git(worktree, 'commit', '-m', 'summary');
    const commit = git(worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited in place\n');

    await expect(applyRunCommit({
      repositoryPath: repo, targetBranch: 'main', expectedBaseCommit: base, commit,
    })).resolves.toEqual({ kind: 'applied', repositoryPath: repo, branch: 'main' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(commit);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('edited in place\n');
  });

  it('blocks a local edit to a tracked file the Run commit also changes', async () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(repo, 'worktree', 'add', '-b', 'agentdeck/run/five', worktree, base);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'changed by the Run\n');
    git(worktree, 'add', 'README.md');
    git(worktree, 'commit', '-m', 'readme');
    const commit = git(worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited by a human\n');

    const result = await applyRunCommit({
      repositoryPath: repo, targetBranch: 'main', expectedBaseCommit: base, commit,
    });

    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' ? result.reason : '').toContain('README.md');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('edited by a human\n');
  });
});
