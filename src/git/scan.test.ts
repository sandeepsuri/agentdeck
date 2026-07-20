import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { checkoutBranch, checkoutExistingBranch, scanRepos } from './scan.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-'));
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
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
  git(dir, 'branch', '-M', 'main');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanRepos', () => {
  it('scans exactly one level for repositories and linked worktrees, caching Repo rows', async () => {
    const root = tempDir();
    const repoPath = path.join(root, 'alpha');
    const worktreePath = path.join(root, 'alpha-feature');
    initRepo(repoPath);
    git(repoPath, 'branch', 'feature');
    git(repoPath, 'worktree', 'add', worktreePath, 'feature');
    fs.mkdirSync(path.join(root, 'plain', 'nested-repo'), { recursive: true });
    git(path.join(root, 'plain', 'nested-repo'), 'init');

    const store = new Store(':memory:');
    const repos = await scanRepos(root, store);

    expect(repos.map((repo) => repo.path)).toEqual([repoPath, worktreePath]);
    expect(repos.find((repo) => repo.path === repoPath)).toMatchObject({
      name: 'alpha',
      currentBranch: 'main',
      isDirty: false,
    });
    expect(repos.find((repo) => repo.path === worktreePath)?.currentBranch).toBe('feature');
    expect(repos[0]?.worktrees?.map((worktree) => worktree.path)).toEqual([
      fs.realpathSync(repoPath),
      fs.realpathSync(worktreePath),
    ]);
    expect(store.listRepos()).toEqual(repos);
    store.close();
  });
});

describe('checkoutExistingBranch', () => {
  it('checks out an existing branch only when the worktree is clean', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);
    git(repoPath, 'branch', 'ready');

    await checkoutExistingBranch(repoPath, 'ready');
    expect(git(repoPath, 'symbolic-ref', '--short', 'HEAD')).toBe('ready');

    fs.writeFileSync(path.join(repoPath, 'README.md'), 'dirty\n');
    await expect(checkoutExistingBranch(repoPath, 'main')).rejects.toThrow(/dirty/i);
    expect(git(repoPath, 'symbolic-ref', '--short', 'HEAD')).toBe('ready');
  });
});

describe('checkoutBranch', () => {
  it('creates a missing branch only when explicitly requested', async () => {
    const repoPath = path.join(tempDir(), 'repo');
    initRepo(repoPath);

    await expect(checkoutBranch(repoPath, 'feature/dashboard')).rejects.toThrow(/does not exist/i);
    await checkoutBranch(repoPath, 'feature/dashboard', true);
    expect(git(repoPath, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/dashboard');
  });
});
