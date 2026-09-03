import { git } from '../git/scan.js';

const DELIVERY_TIMEOUT_MS = 30_000;
const INTERNAL_PATH_PREFIXES = ['.agents/', '.agentdeck/'];

function taskPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, '');
  return normalized !== '.agents' && normalized !== '.agentdeck'
    && !INTERNAL_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every path Git's porcelain status reports for a checkout — staged, modified,
 * and untracked alike, with nothing filtered out. This answers "what
 * uncommitted work is sitting in this checkout?", which is a different
 * question from observeRunChanges' "what did the Run author?": internal
 * coordination state under .agents/ is not part of a requested change, but it
 * is absolutely uncommitted work a fast-forward could clobber.
 */
async function uncommittedPaths(repositoryPath: string): Promise<readonly string[]> {
  // --branch supplies a first record without leading whitespace, preventing
  // git()'s outer trim from damaging the first porcelain status column.
  const status = await git(repositoryPath, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const records = status.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith('## ') || record.length < 4 || record[2] !== ' ') continue;
    paths.push(record.slice(3));
    // A rename/copy spends a second NUL-separated field on its origin path.
    // Both sides matter here — and consuming it explicitly also stops that
    // bare path from being silently dropped by the shape test above.
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') {
      const origin = records[index + 1];
      if (origin) paths.push(origin);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

/**
 * The paths a fast-forward to `commit` would touch on disk. Rename detection
 * is deliberately off: a rename moves two paths in the working tree, and both
 * are hazards, so both must be named.
 */
async function incomingPaths(repositoryPath: string, baseCommit: string, commit: string): Promise<readonly string[]> {
  const diff = await git(repositoryPath, ['diff', '--name-only', '-z', '--no-renames', baseCommit, commit]);
  return [...new Set(diff.split('\0').filter(Boolean))];
}

/**
 * The task-authored paths currently present in a Run worktree. Internal
 * coordination state is deliberately excluded: it exists to operate the
 * Run, not as part of the requested repository change.
 */
export async function observeRunChanges(worktreePath: string): Promise<readonly string[]> {
  // --branch supplies a first record without leading whitespace, preventing
  // git()'s outer trim from damaging the first porcelain status column.
  const status = await git(worktreePath, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const paths = status.split('\0').flatMap((record) => {
    if (record.startsWith('## ') || record.length < 4 || record[2] !== ' ') return [];
    return [record.slice(3)];
  });
  return [...new Set(paths.filter(taskPath))].sort();
}

export type ApplyRunCommitResult =
  | { readonly kind: 'applied'; readonly repositoryPath: string; readonly branch: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ApplyRunCommitInput {
  readonly repositoryPath: string;
  readonly targetBranch?: string;
  readonly expectedBaseCommit: string;
  readonly commit: string;
}

/**
 * Safely advances the selected Repository checkout to a verified Run commit.
 * It never switches branches, rewrites history, or attempts a conflicted
 * merge. Anything other than a clean, unchanged, fast-forwardable checkout
 * is returned as an actionable blocker and left untouched.
 */
export async function applyRunCommit(input: ApplyRunCommitInput): Promise<ApplyRunCommitResult> {
  if (!input.targetBranch) {
    return { kind: 'blocked', reason: 'The requested base was not a local branch, so AgentDeck could not choose a checkout to update.' };
  }
  try {
    const currentBranch = await git(input.repositoryPath, ['symbolic-ref', '--short', 'HEAD']);
    if (currentBranch !== input.targetBranch) {
      return {
        kind: 'blocked',
        reason: `The Repository checkout is on ${currentBranch}, not ${input.targetBranch}. Switch to ${input.targetBranch}, then apply this result.`,
      };
    }

    const currentHead = await git(input.repositoryPath, ['rev-parse', 'HEAD']);
    if (currentHead !== input.expectedBaseCommit) {
      return {
        kind: 'blocked',
        reason: `The ${input.targetBranch} branch moved after this Run started. Rebase and reverify the Run before applying it.`,
      };
    }

    try {
      await git(input.repositoryPath, ['merge-base', '--is-ancestor', input.expectedBaseCommit, input.commit]);
    } catch {
      return { kind: 'blocked', reason: 'The Run commit is no longer a fast-forward from its recorded base. Rebase and reverify it before applying.' };
    }

    // Only work the fast-forward would actually overwrite is a reason to stop.
    // Uncommitted files elsewhere in the checkout are untouched by a
    // fast-forward, and vetoing on those made an unrelated stray file silently
    // withhold a finished Run's result.
    const incoming = new Set(await incomingPaths(input.repositoryPath, input.expectedBaseCommit, input.commit));
    const collisions = (await uncommittedPaths(input.repositoryPath)).filter((path) => incoming.has(path)).sort();
    if (collisions.length > 0) {
      return {
        kind: 'blocked',
        reason: `The Repository checkout has uncommitted changes to files this Run also changes (${collisions.slice(0, 3).join(', ')}${collisions.length > 3 ? ', …' : ''}). Commit or stash them, then apply this result.`,
      };
    }

    try {
      await git(input.repositoryPath, ['merge', '--ff-only', '--no-edit', input.commit], { timeoutMs: DELIVERY_TIMEOUT_MS });
    } catch (error) {
      // Git is the backstop for every hazard the collision check above cannot
      // see. When it refuses, it refuses before touching anything, and its own
      // message names what the operator has to resolve — so this is a blocker
      // for a human, not an AgentDeck failure.
      return { kind: 'blocked', reason: describeFailure(error) };
    }
    const appliedHead = await git(input.repositoryPath, ['rev-parse', 'HEAD']);
    if (appliedHead !== input.commit) {
      return { kind: 'failed', reason: 'Git completed without placing the Repository checkout at the Run commit.' };
    }
    return { kind: 'applied', repositoryPath: input.repositoryPath, branch: input.targetBranch };
  } catch (error) {
    return { kind: 'failed', reason: describeFailure(error) };
  }
}
