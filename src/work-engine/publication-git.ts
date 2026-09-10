// Ticket 13: the real, Node-only half of a Run's publication — git for the
// branch, GitHub CLI (via GitPublishService's own preflight and creation
// path) for the pull request, and the PR body builder. Split out of
// publication.ts, which stays reachable from browser UI code and must never
// import git/publish.ts (see that file's own header comment for why).
// createGitRunPublisher shares the same CommandRunner and GitPublishService
// git/publish.ts already uses for the human publish flow, so the remote
// restrictions that flow holds (origin only; pull requests only for a
// GitHub origin, via an authenticated gh) are the same ones a Run's
// publication meets, not a second copy of them.
import {
  createGitPublishService, MAX_PR_TITLE_LENGTH, runCommand, type CommandRunner,
} from '../git/publish.js';
import {
  redactRemoteUrl, RemoteUnobservableError,
} from './publication.js';
import type {
  PullRequestInput, RemoteObservation, RunPublisher,
} from './publication.js';
import type { RunPublication, RunPublicationPullRequest, WorkRun } from './types.js';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pull request base a Run's frozen requestedBaseReference names — a bare branch name, or the reference as given when it is not a branch (createPullRequest then refuses it precisely). */
export function pullRequestBase(requestedBaseReference: string): string {
  return requestedBaseReference.replace(/^refs\/heads\//, '');
}

export function buildPullRequestInput(run: WorkRun, intent: RunPublication): PullRequestInput {
  const objective = run.spec.objective.trim().split('\n')[0] ?? '';
  const title = objective.length > MAX_PR_TITLE_LENGTH ? `${objective.slice(0, MAX_PR_TITLE_LENGTH - 1)}…` : objective;
  const criteria = run.spec.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  const body = [
    run.spec.objective,
    '',
    '## Acceptance criteria',
    criteria,
    '',
    `AgentDeck-Run: ${run.id}`,
    `AgentDeck-Principal: ${run.principal.displayName} (${run.principal.id})`,
    `AgentDeck-Published-By: ${intent.authorizedBy.displayName} (${intent.authorizedBy.id})`,
  ].join('\n');
  return { base: pullRequestBase(run.spec.requestedBaseReference), title, body };
}

function parsePullRequestList(raw: string): RunPublicationPullRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RemoteUnobservableError('GitHub CLI returned an unreadable pull request list.');
  }
  if (!Array.isArray(parsed)) throw new RemoteUnobservableError('GitHub CLI returned an unreadable pull request list.');
  const first = parsed[0] as Record<string, unknown> | undefined;
  if (!first || typeof first.number !== 'number' || typeof first.url !== 'string') return undefined;
  return {
    number: first.number,
    url: first.url,
    title: typeof first.title === 'string' ? first.title : '',
    draft: first.isDraft === true,
  };
}

/** The real port: git for the branch, GitHub CLI (via GitPublishService's own preflight and creation path) for the pull request. */
export function createGitRunPublisher(runner: CommandRunner = runCommand): RunPublisher {
  const publishService = createGitPublishService(runner);
  const execute = (cwd: string, command: string, args: string[], timeoutMs = 20_000) =>
    runner(command, args, { cwd, timeoutMs });

  return {
    async localHead(worktreePath) {
      const commit = (await execute(worktreePath, 'git', ['rev-parse', 'HEAD'])).stdout;
      let branch: string | undefined;
      try {
        branch = (await execute(worktreePath, 'git', ['symbolic-ref', '--short', 'HEAD'])).stdout || undefined;
      } catch {
        branch = undefined;
      }
      return branch ? { commit, branch } : { commit };
    },

    async observe(worktreePath, branch, options) {
      let remoteUrl: string;
      try {
        remoteUrl = redactRemoteUrl((await execute(worktreePath, 'git', ['remote', 'get-url', 'origin'])).stdout);
      } catch {
        throw new Error('Add an origin remote before publishing.');
      }
      let heads: string;
      try {
        heads = (await execute(worktreePath, 'git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 60_000)).stdout;
      } catch (error) {
        throw new RemoteUnobservableError(describeError(error));
      }
      const remoteCommit = heads.split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => line.split(/\s+/))
        .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
      let pullRequest: RunPublicationPullRequest | undefined;
      if (options.pullRequest) {
        let listed: string;
        try {
          listed = (await execute(worktreePath, 'gh', [
            'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,title,isDraft', '--limit', '1',
          ], 60_000)).stdout;
        } catch (error) {
          throw new RemoteUnobservableError(describeError(error));
        }
        pullRequest = parsePullRequestList(listed);
      }
      return {
        remoteUrl,
        ...(remoteCommit ? { remoteCommit } : {}),
        ...(pullRequest ? { pullRequest } : {}),
      } satisfies RemoteObservation;
    },

    async push(worktreePath, commit, branch) {
      // `--force-with-lease=<ref>:` (empty expectation) means "the ref must
      // not exist yet on origin" — the push creates the branch exactly once
      // and is refused, atomically at the remote, if anyone (including an
      // earlier execution of this same intent) got there first. It never
      // forces over an existing ref, fast-forwardable or not: what origin
      // already has is reconciled by observe(), not overwritten here.
      await execute(worktreePath, 'git', [
        'push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${commit}:refs/heads/${branch}`,
      ], 120_000);
    },

    async createDraftPullRequest(worktreePath, input) {
      const created = await publishService.createPullRequest(worktreePath, { ...input, draft: true });
      return {
        number: created.number, url: created.url, title: created.title, draft: created.draft,
      };
    },
  };
}
