// Ticket 10: creates the local commit an ordinarily-successful, verified Run
// delivers (AC1). Every commit this module makes carries AgentDeck's own
// automation identity as both author and committer (AC2) — never the local
// operator's own `git config user.name`/`user.email`, and never anything
// resembling git/publish.ts's identity model, which is deliberately the
// opposite: that module commits AS the human, for their own manual publish
// flow. The Run's Principal is recorded in the commit message body instead
// (buildCommitMessage), not as the commit's author — the two questions
// ("who made this commit, mechanically" and "who asked for it") are kept
// separate on purpose. Signing is attempted only when the worktree's own Git
// configuration already asks for it (AC3: optional, never invented here);
// a signing failure falls back to an unsigned commit rather than losing the
// work, and never carries raw signer output (which can echo key ids or
// passphrase prompts) into the durable failure reason.
import { git } from '../git/scan.js';
import { observeRunChanges } from './delivery.js';
import type { RunPrincipal } from './types.js';

const COMMIT_TIMEOUT_MS = 30_000;

/** The one identity every Run's local commit carries — never a human's, never configurable per Run. */
export const AGENTDECK_COMMIT_IDENTITY = Object.freeze({ name: 'AgentDeck', email: 'noreply@agentdeck.local' });

/** A trailer value must stay one line — a Principal field containing a newline could otherwise inject extra trailers into the commit message. */
function sanitizeTrailerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** The commit message body: the objective as the subject, with Run/Principal metadata as trailers (AC2). */
export function buildCommitMessage(objective: string, runId: string, principal: RunPrincipal): string {
  const displayName = sanitizeTrailerValue(principal.displayName);
  const id = sanitizeTrailerValue(principal.id);
  return `${objective}\n\nAgentDeck-Run: ${sanitizeTrailerValue(runId)}\nAgentDeck-Principal: ${displayName} (${id})\n`;
}

export type LocalCommitResult =
  | { readonly kind: 'no-changes' }
  | {
    readonly kind: 'committed';
    readonly sha: string;
    readonly branch: string;
    readonly signed: boolean;
    readonly changedFiles: readonly string[];
  }
  | { readonly kind: 'failed'; readonly reason: string };

/** Prefers stderr over stdout/message, exactly like prepare.ts's own git-failure handling — this module's raw `git()` calls never normalize their own errors. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function isSigningConfigured(worktreePath: string): Promise<boolean> {
  try {
    return (await git(worktreePath, ['config', '--get', 'commit.gpgsign'])).trim() === 'true';
  } catch {
    return false;
  }
}

type CommitAttemptResult = { readonly ok: true; readonly signed: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Commits whatever is staged with AgentDeck's own identity, signed if the
 * worktree's Git configuration already asks for it. A signing failure falls
 * back to an unsigned commit rather than losing the work (AC3) — its own
 * stderr (which can echo key ids or passphrase prompts) is discarded rather
 * than surfaced, on the theory that a generic "signing failed" note is no
 * more useful than `signed: false` already is, and strictly safer.
 */
async function commitStaged(worktreePath: string, message: string, env: NodeJS.ProcessEnv): Promise<CommitAttemptResult> {
  const gitOptions = { env, timeoutMs: COMMIT_TIMEOUT_MS };
  if (!(await isSigningConfigured(worktreePath))) {
    try {
      await git(worktreePath, ['commit', '-m', message], gitOptions);
      return { ok: true, signed: false };
    } catch (error) {
      return { ok: false, reason: describeFailure(error) };
    }
  }
  try {
    await git(worktreePath, ['commit', '-S', '-m', message], gitOptions);
    return { ok: true, signed: true };
  } catch {
    try {
      await git(worktreePath, ['commit', '--no-gpg-sign', '-m', message], gitOptions);
      return { ok: true, signed: false };
    } catch (error) {
      return { ok: false, reason: describeFailure(error) };
    }
  }
}

/**
 * Stages everything in `worktreePath` and, if that changes anything, commits
 * it with AgentDeck's own identity (AC2). Never pushes, never opens a pull
 * request (AC6) — it only ever touches this one already-isolated worktree
 * (ticket 03's Git boundary), never the Repository it was cloned from.
 */
export async function createLocalCommit(worktreePath: string, message: string): Promise<LocalCommitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: AGENTDECK_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: AGENTDECK_COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: AGENTDECK_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: AGENTDECK_COMMIT_IDENTITY.email,
  };
  const gitOptions = { env, timeoutMs: COMMIT_TIMEOUT_MS };
  try {
    // Stage exactly the task-authored paths observed by the delivery module.
    // AgentDeck's own coordination directories operate the Run and are never
    // allowed to leak into a delivery commit.
    const taskChanges = await observeRunChanges(worktreePath);
    if (taskChanges.length === 0) return { kind: 'no-changes' };
    await git(worktreePath, ['add', '-A', '--', ...taskChanges], gitOptions);
    const staged = await git(worktreePath, ['diff', '--cached', '--name-only'], gitOptions);
    const changedFiles = staged.split('\n').map((line) => line.trim()).filter(Boolean);
    if (changedFiles.length === 0) return { kind: 'no-changes' };

    const committed = await commitStaged(worktreePath, message, env);
    if (!committed.ok) return { kind: 'failed', reason: committed.reason };

    const sha = await git(worktreePath, ['rev-parse', 'HEAD'], gitOptions);
    const branch = await git(worktreePath, ['symbolic-ref', '--short', 'HEAD'], gitOptions);
    return {
      kind: 'committed', sha, branch, signed: committed.signed, changedFiles,
    };
  } catch (error) {
    return { kind: 'failed', reason: describeFailure(error) };
  }
}
