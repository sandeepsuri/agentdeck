// Ticket 13: the RunPublisher port and executePublication orchestrator —
// reconcile first, then do only what the remote provably hasn't got yet.
// Never force-pushes, never guesses, and reports exactly one of three
// settled outcomes — succeeded, failed (provably did not happen; safe to
// retry), or ambiguous (neither could be proven; the admin must look) — so
// a restart mid-push (AC5/AC6) and a repeated command (AC3) both land on
// the truth rather than on a duplicate or a lost effect.
//
// Deliberately free of any Node-only import (no `node:*`, no git/publish.ts):
// this module is reached from browser UI code (RunWorkspace.tsx imports
// defaultPublicationTarget), and git/publish.ts's own top-level
// `gitPublishService = createGitPublishService()` side effect defeats
// tree-shaking, so importing anything from it here would pull the whole
// Node child_process/fs chain into the Vite bundle. The real, git/gh-backed
// RunPublisher implementation (createGitRunPublisher) and the pull-request
// body builder live in publication-git.ts instead, imported only by
// server-side code (engine.ts, its own tests).
//
// Every reason that reaches durable storage passes through redactSecrets:
// git and gh happily echo a credential embedded in a remote URL back in
// their error text, and that must never land in a Run record or a REST
// response.
import type {
  PublicationTarget, RequestedDeliveryResult, RunPublication, RunPublicationPullRequest, RunPublicationResult,
} from './types.js';

const PUBLICATION_TARGETS: readonly PublicationTarget[] = ['push', 'draft-pull-request'];

/** Shared by the REST route and DurableWorkEngine.publish() so a malformed target is rejected identically whether it came from an HTTP body or a direct engine call. */
export function isPublicationTarget(value: unknown): value is PublicationTarget {
  return typeof value === 'string' && (PUBLICATION_TARGETS as readonly string[]).includes(value);
}

/** What a Run's own frozen delivery request implies when the caller doesn't name a target explicitly — a pull-request-requesting Run defaults to opening one, everything else to a plain push. */
export function defaultPublicationTarget(requestedDeliveryResult: RequestedDeliveryResult): PublicationTarget {
  return requestedDeliveryResult === 'pull-request' ? 'draft-pull-request' : 'push';
}

/** The remote exists but could not be observed right now — network, auth, or a hung command. Never raised for a definite answer such as "the branch is absent". */
export class RemoteUnobservableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnobservableError';
  }
}

export interface LocalHead {
  readonly commit: string;
  /** Undefined on a detached HEAD. */
  readonly branch?: string;
}

export interface RemoteObservation {
  /** origin's URL with any embedded credentials already redacted. */
  readonly remoteUrl: string;
  /** The commit refs/heads/<branch> points at on origin, or undefined when origin has no such branch. */
  readonly remoteCommit?: string;
  /** Only looked up when asked for — an open pull request whose head is the branch. */
  readonly pullRequest?: RunPublicationPullRequest;
}

export interface PullRequestInput {
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface RunPublisher {
  /** The worktree's current HEAD — the local half of the divergence check. */
  localHead(worktreePath: string): Promise<LocalHead>;
  /**
   * Observes origin without changing anything. Rejects with
   * RemoteUnobservableError when the remote cannot be reached, and with a
   * plain Error for a definite blocker (no origin remote at all).
   */
  observe(worktreePath: string, branch: string, options: { readonly pullRequest: boolean }): Promise<RemoteObservation>;
  /** Creates refs/heads/<branch> on origin at exactly `commit` — refused if the ref already exists, never forced over one. */
  push(worktreePath: string, commit: string, branch: string): Promise<void>;
  createDraftPullRequest(worktreePath: string, input: PullRequestInput): Promise<RunPublicationPullRequest>;
}

const URL_CREDENTIALS = /(\w+:\/\/)[^/@\s]+@/g;
/** GitHub-style tokens: ghp_/gho_/ghs_/ghu_/ghr_ classic tokens and github_pat_ fine-grained tokens. */
const TOKEN_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;

/** Strips userinfo (user:token@) out of a URL — the one place a remote URL could carry a credential. */
export function redactRemoteUrl(url: string): string {
  return url.replace(URL_CREDENTIALS, '$1***@');
}

/** Scrubs anything credential-shaped out of free text before it becomes a durable reason. */
export function redactSecrets(text: string): string {
  return redactRemoteUrl(text).replace(TOKEN_LIKE, '***');
}

function describeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export type PublicationOutcome =
  | { readonly state: 'succeeded'; readonly result: RunPublicationResult }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'ambiguous'; readonly reason: string };

export interface PublicationContext {
  readonly worktreePath: string;
  readonly pullRequest: PullRequestInput;
}

export interface ExecutePublicationOptions {
  /**
   * True when an earlier execution of this same intent may already have
   * sent a command — the intent was 'executing' when the previous process
   * stopped, or is already 'ambiguous'. It changes exactly one thing: an
   * unobservable remote before anything is sent is then 'ambiguous' (a
   * prior push may have landed) rather than a plain 'failed' (nothing has
   * ever been sent, so nothing is in doubt).
   */
  readonly priorExecution: boolean;
}

/**
 * One execution of a durable publication intent. Reads the local head and
 * origin first, then pushes only if origin lacks the authorized commit and
 * opens a draft pull request only if none is open — so resuming after a
 * crash, or running the same command twice, converges on one push and one
 * pull request. Divergence in either direction (the local branch moved, or
 * origin's branch is at some other commit) is a definite failure: AgentDeck
 * never force-pushes over someone else's work.
 */
export async function executePublication(
  publisher: RunPublisher,
  intent: RunPublication,
  context: PublicationContext,
  options: ExecutePublicationOptions,
): Promise<PublicationOutcome> {
  const { worktreePath } = context;
  const wantsPullRequest = intent.target === 'draft-pull-request';
  const observe = () => publisher.observe(worktreePath, intent.branch, { pullRequest: wantsPullRequest });

  let head: LocalHead;
  try {
    head = await publisher.localHead(worktreePath);
  } catch (error) {
    return { state: 'failed', reason: `The Run worktree could not be read: ${describeError(error)}` };
  }
  if (head.commit !== intent.commit) {
    return {
      state: 'failed',
      reason: `The Run branch ${intent.branch} is at ${head.commit}, not the authorized commit ${intent.commit}; nothing was published.`,
    };
  }
  // The Run's own worktree lives on a dedicated branch it never switches
  // off of (prepare.ts); a detached or different HEAD at the same commit
  // (a shared worktree checked out elsewhere, say) still means the intent's
  // named branch is not what would actually be published.
  if (head.branch !== undefined && head.branch !== intent.branch) {
    return {
      state: 'failed',
      reason: `The Run worktree is on branch ${head.branch}, not the authorized branch ${intent.branch}; nothing was published.`,
    };
  }

  let observation: RemoteObservation;
  try {
    observation = await observe();
  } catch (error) {
    if (error instanceof RemoteUnobservableError) {
      return options.priorExecution
        ? { state: 'ambiguous', reason: `origin could not be observed to confirm whether an earlier attempt published this commit: ${describeError(error)}` }
        : { state: 'failed', reason: `origin could not be reached; nothing was published: ${describeError(error)}` };
    }
    return { state: 'failed', reason: describeError(error) };
  }

  const diverged = (remoteCommit: string): PublicationOutcome => ({
    state: 'failed',
    reason: `origin/${intent.branch} is at ${remoteCommit}, not the authorized commit ${intent.commit}; AgentDeck never force-pushes over it.`,
  });
  if (observation.remoteCommit !== undefined && observation.remoteCommit !== intent.commit) {
    return diverged(observation.remoteCommit);
  }

  if (observation.remoteCommit === undefined) {
    try {
      await publisher.push(worktreePath, intent.commit, intent.branch);
    } catch (pushError) {
      // The push command failed — but a failed command is not proof the
      // push did not land (a timeout after the server accepted it, say).
      // Only the remote itself can say.
      let after: RemoteObservation;
      try {
        after = await observe();
      } catch {
        return {
          state: 'ambiguous',
          reason: `The push to origin failed (${describeError(pushError)}) and origin could not be observed afterward to tell whether ${intent.branch} was updated.`,
        };
      }
      if (after.remoteCommit === undefined) {
        return { state: 'failed', reason: `The push to origin failed; nothing was published: ${describeError(pushError)}` };
      }
      if (after.remoteCommit !== intent.commit) return diverged(after.remoteCommit);
      observation = after;
    }
  }

  let pullRequest = observation.pullRequest;
  if (wantsPullRequest && !pullRequest) {
    try {
      pullRequest = await publisher.createDraftPullRequest(worktreePath, context.pullRequest);
    } catch (prError) {
      let after: RemoteObservation;
      try {
        after = await observe();
      } catch {
        return {
          state: 'ambiguous',
          reason: `The branch was pushed, but creating the draft pull request failed (${describeError(prError)}) and GitHub could not be observed afterward to tell whether one exists.`,
        };
      }
      if (!after.pullRequest) {
        return { state: 'failed', reason: `The branch was pushed, but the draft pull request could not be created: ${describeError(prError)}` };
      }
      pullRequest = after.pullRequest;
    }
  }

  return {
    state: 'succeeded',
    result: {
      remote: { name: 'origin', url: observation.remoteUrl },
      branch: intent.branch,
      commit: intent.commit,
      ...(pullRequest ? { pullRequest } : {}),
    },
  };
}
