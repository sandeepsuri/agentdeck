import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Store } from '../store/index.js';
import type { Repo } from '../types.js';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return stdout.trim();
}

function parseDirtyFiles(output: string): string[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').at(-1) ?? '')
    .filter(Boolean);
}

export function parseWorktrees(output: string): NonNullable<Repo['worktrees']> {
  const worktrees: NonNullable<Repo['worktrees']> = [];
  for (const block of output.trim().split(/\n\n+/)) {
    const lines = block.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice(18);
    if (worktreePath && branch) worktrees.push({ path: worktreePath, branch });
  }
  return worktrees;
}

async function inspectRepo(repoPath: string): Promise<Repo> {
  const [status, worktreeOutput] = await Promise.all([
    git(repoPath, ['status', '--porcelain']),
    git(repoPath, ['worktree', 'list', '--porcelain']),
  ]);
  let branch: string | undefined;
  try {
    branch = await git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    // Detached HEAD is still a valid repository/worktree.
  }
  const dirtyFiles = parseDirtyFiles(status);
  const repo: Repo = {
    id: repoPath,
    path: repoPath,
    name: path.basename(repoPath),
    isDirty: dirtyFiles.length > 0,
    dirtyFiles,
    worktrees: parseWorktrees(worktreeOutput),
  };
  if (branch) repo.currentBranch = branch;
  return repo;
}

export async function scanRepos(projectsDir: string, store?: Store): Promise<Repo[]> {
  const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsDir, entry.name))
    .filter((candidate) => fs.existsSync(path.join(candidate, '.git')));

  const inspected = await Promise.allSettled(candidates.map(inspectRepo));
  const repos = inspected
    .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const repo of repos) store?.upsertRepo(repo);
  return repos;
}

export async function checkoutExistingBranch(cwd: string, branch: string): Promise<void> {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status) throw new Error('Cannot check out a branch: the working tree is dirty.');
  try {
    await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    throw new Error(`Branch does not exist locally: ${branch}`);
  }
  await git(cwd, ['checkout', branch]);
}

export async function checkoutBranch(cwd: string, branch: string, createIfMissing = false): Promise<void> {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status) throw new Error('Cannot change branches: the working tree is dirty.');
  let exists = true;
  try {
    await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    exists = false;
  }
  if (!exists && !createIfMissing) throw new Error(`Branch does not exist locally: ${branch}`);
  await git(cwd, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
}
