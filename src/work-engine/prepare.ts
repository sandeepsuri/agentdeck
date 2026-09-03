// Git operations backing Run preparation (ticket 03): resolve the frozen
// requestedBaseReference to an exact local commit with no implicit fetch,
// then create a dedicated, clean worktree for it. Never deletes a worktree —
// that stays unavailable until a future explicit authorized cleanup action.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git/scan.js';
import type { RunRepository } from './types.js';

export class RunPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPreparationError';
  }
}

async function refExists(repoPath: string, args: string[]): Promise<boolean> {
  try {
    await git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

export function runWorktreePath(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId);
}

export function runBranchName(runId: string): string {
  return `agentdeck/run/${runId}`;
}

export interface PreparedWorktree {
  baseCommit: string;
  worktreePath: string;
  branch: string;
  /** Local branch the requested base named at preparation time; absent for a tag/SHA/detached HEAD. */
  targetBranch?: string;
}

/**
 * Resolves `requestedBaseReference` to an exact local commit inside
 * `repository.path` (the Repository boundary — never any other directory,
 * never a fetch) and creates a brand-new worktree + branch for `runId`
 * beneath `runsRoot`. Throws RunPreparationError with a precise, recoverable
 * message on any collision or Git failure; never removes anything it (or a
 * prior attempt) already created on disk.
 */
export async function prepareRunWorktree(
  repository: RunRepository,
  requestedBaseReference: string,
  runId: string,
  runsRoot: string,
): Promise<PreparedWorktree> {
  if (!fs.existsSync(repository.path)) {
    throw new RunPreparationError(`Repository no longer exists at its recorded path: ${repository.path}`);
  }
  if (!(await refExists(repository.path, ['rev-parse', '--git-dir']))) {
    throw new RunPreparationError(`Repository path is not a Git repository: ${repository.path}`);
  }

  let baseCommit: string;
  let targetBranch: string | undefined;
  try {
    baseCommit = await git(repository.path, ['rev-parse', '--verify', `${requestedBaseReference}^{commit}`]);
    const symbolicBase = await git(repository.path, ['rev-parse', '--symbolic-full-name', requestedBaseReference]);
    if (symbolicBase.startsWith('refs/heads/')) targetBranch = symbolicBase.slice('refs/heads/'.length);
    if (requestedBaseReference === 'HEAD') {
      try {
        targetBranch = await git(repository.path, ['symbolic-ref', '--short', 'HEAD']);
      } catch {
        targetBranch = undefined;
      }
    }
  } catch {
    throw new RunPreparationError(`Base reference does not exist locally: ${requestedBaseReference}`);
  }

  const worktreePath = runWorktreePath(runsRoot, runId);
  if (fs.existsSync(worktreePath)) {
    throw new RunPreparationError(`Worktree path already exists: ${worktreePath}`);
  }

  const branch = runBranchName(runId);
  if (await refExists(repository.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new RunPreparationError(`Branch already exists: ${branch}`);
  }

  fs.mkdirSync(runsRoot, { recursive: true });
  try {
    await git(repository.path, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error instanceof Error ? error.message : String(error);
    throw new RunPreparationError(`Failed to create worktree: ${detail}`);
  }

  return { baseCommit, worktreePath, branch, ...(targetBranch ? { targetBranch } : {}) };
}
