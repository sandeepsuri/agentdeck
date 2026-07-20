import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { findExecutableInPath } from '../sessions/executable.js';
import { parseNameStatus, parseNumstat, type DiffFileSummary } from './diff.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export interface PublishBlocker {
  code: 'detached_head' | 'missing_origin' | 'unsupported_remote' | 'missing_base'
    | 'on_base_branch' | 'gh_missing' | 'gh_unauthenticated' | 'missing_identity'
    | 'nothing_to_publish' | 'existing_pr';
  message: string;
}

export interface ExistingPullRequest {
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
}

export interface PublishStatus {
  branch?: string;
  baseBranch?: string;
  baseCandidates: string[];
  remote?: { name: 'origin'; url: string; github: boolean };
  upstream?: string;
  ahead: number;
  stagedFiles: DiffFileSummary[];
  unstagedCount: number;
  identity: { configured: boolean; name?: string; email?: string };
  github: {
    state: 'missing' | 'unauthenticated' | 'ready';
    installed: boolean;
    authenticated: boolean;
    account?: string;
    detail: string;
  };
  existingPr?: ExistingPullRequest;
  canCommit: boolean;
  canCreatePr: boolean;
  blockers: PublishBlocker[];
}

export interface GitPublishService {
  status(repoPath: string): Promise<PublishStatus>;
  commit(repoPath: string, subject: string, body?: string): Promise<{ sha: string; subject: string }>;
  push(repoPath: string): Promise<{ remote: 'origin'; branch: string; upstream: string }>;
  createPullRequest(repoPath: string, input: {
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<ExistingPullRequest>;
}

export const MAX_COMMIT_SUBJECT_LENGTH = 160;
export const MAX_PR_TITLE_LENGTH = 256;
export const MAX_PUBLISH_BODY_LENGTH = 64 * 1024;

const COMMON_GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

export function resolveGitHubExecutable(
  pathValue = process.env.PATH ?? '',
  commonCandidates: string[] = COMMON_GH_PATHS,
): string | undefined {
  const fromPath = findExecutableInPath('gh', pathValue);
  if (fromPath) return fromPath;
  return commonCandidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export const runCommand: CommandRunner = async (command, args, options) => {
  try {
    const executable = command === 'gh' ? resolveGitHubExecutable() ?? command : command;
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const commandError = error as Error & { stderr?: string; stdout?: string };
    const detail = commandError.stderr?.trim() || commandError.stdout?.trim() || commandError.message;
    throw new Error(detail);
  }
};

function isGitHubRemote(remote: string): boolean {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(remote);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function parsePullRequest(raw: string): ExistingPullRequest | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.number !== 'number' || typeof value.url !== 'string') return undefined;
    return {
      number: value.number,
      url: value.url,
      title: typeof value.title === 'string' ? value.title : '',
      state: typeof value.state === 'string' ? value.state : 'OPEN',
      draft: value.isDraft === true,
    };
  } catch {
    return undefined;
  }
}

function porcelainEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const path = line.slice(3).split(' -> ').at(-1)?.replace(/^"|"$/g, '');
    if (path) entries.set(path, line.slice(0, 2));
  }
  return entries;
}

export function createGitPublishService(runner: CommandRunner = runCommand): GitPublishService {
  const execute = (repoPath: string, command: string, args: string[], timeoutMs = 15_000) =>
    runner(command, args, { cwd: repoPath, timeoutMs });
  const attempt = async (repoPath: string, command: string, args: string[], timeoutMs = 15_000) => {
    try { return await execute(repoPath, command, args, timeoutMs); } catch { return undefined; }
  };
  const inspect = async (repoPath: string, command: string, args: string[], timeoutMs = 15_000) => {
    try {
      return { result: await execute(repoPath, command, args, timeoutMs) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const currentBranch = async (repoPath: string) =>
    (await attempt(repoPath, 'git', ['symbolic-ref', '--short', 'HEAD']))?.stdout || undefined;

  const baseCandidates = async (repoPath: string): Promise<string[]> => {
    const remoteHead = (await attempt(repoPath, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.stdout;
    const headBranch = remoteHead?.startsWith('origin/') ? remoteHead.slice(7) : undefined;
    const remoteRefs = (await attempt(repoPath, 'git', [
      'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin',
    ]))?.stdout.split('\n').filter(Boolean).map((ref) => ref.startsWith('origin/') ? ref.slice(7) : ref) ?? [];
    let localFallback: string | undefined;
    for (const candidate of ['main', 'master']) {
      if (await attempt(repoPath, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) {
        localFallback = candidate;
        break;
      }
    }
    return unique([headBranch, localFallback, ...remoteRefs.filter((ref) => ref !== 'HEAD')]);
  };

  const stagedFiles = async (repoPath: string): Promise<DiffFileSummary[]> => {
    const [numstatResult, nameStatusResult] = await Promise.all([
      execute(repoPath, 'git', ['diff', '--cached', '--no-renames', '--numstat']),
      execute(repoPath, 'git', ['diff', '--cached', '--no-renames', '--name-status']),
    ]);
    const stats = parseNumstat(numstatResult.stdout);
    const statuses = parseNameStatus(nameStatusResult.stdout);
    return [...stats].map(([filePath, stat]) => ({
      path: filePath,
      status: statuses.get(filePath) ?? 'M',
      ...stat,
      indexStatus: statuses.get(filePath) === '?' ? undefined : (statuses.get(filePath) ?? 'M') as Exclude<DiffFileSummary['status'], '?'>,
      staged: true,
      partiallyStaged: false,
    }));
  };

  const findExistingPr = async (repoPath: string, branch: string): Promise<ExistingPullRequest | undefined> => {
    const result = await attempt(repoPath, 'gh', [
      'pr', 'view', branch, '--json', 'number,url,title,state,isDraft',
    ], 20_000);
    return result ? parsePullRequest(result.stdout) : undefined;
  };

  const status = async (repoPath: string): Promise<PublishStatus> => {
    const [branch, candidates, origin, name, email, staged, porcelain, upstream, ghVersion] = await Promise.all([
      currentBranch(repoPath),
      baseCandidates(repoPath),
      attempt(repoPath, 'git', ['remote', 'get-url', 'origin']),
      attempt(repoPath, 'git', ['config', '--get', 'user.name']),
      attempt(repoPath, 'git', ['config', '--get', 'user.email']),
      stagedFiles(repoPath),
      execute(repoPath, 'git', ['status', '--porcelain', '--untracked-files=all']),
      attempt(repoPath, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      attempt(repoPath, 'gh', ['--version']),
    ]);
    const baseBranch = candidates[0];
    const remoteUrl = origin?.stdout;
    const githubRemote = Boolean(remoteUrl && isGitHubRemote(remoteUrl));
    const ghAuthCheck = ghVersion
      ? await inspect(repoPath, 'gh', ['auth', 'status', '--hostname', 'github.com'], 20_000)
      : undefined;
    const ghAuth = ghAuthCheck?.result;
    const account = ghAuth ? (await attempt(repoPath, 'gh', ['api', 'user', '--jq', '.login'], 20_000))?.stdout : undefined;
    const existingPr = branch && githubRemote && ghAuth ? await findExistingPr(repoPath, branch) : undefined;
    const aheadRef = baseBranch
      ? (await attempt(repoPath, 'git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`]))
        ? `origin/${baseBranch}` : baseBranch
      : undefined;
    const aheadOutput = aheadRef ? await attempt(repoPath, 'git', ['rev-list', '--count', `${aheadRef}..HEAD`]) : undefined;
    const ahead = Number(aheadOutput?.stdout) || 0;
    const worktreeEntries = porcelainEntries(porcelain.stdout);
    const stagedWithState: DiffFileSummary[] = staged.map((file) => {
      const code = worktreeEntries.get(file.path);
      let worktreeStatus: DiffFileSummary['worktreeStatus'];
      if (code?.[1] && code[1] !== ' ') {
        worktreeStatus = code[1] === '?' ? '?' : code[1] === 'A' || code[1] === 'D' || code[1] === 'R' ? code[1] : 'M';
      }
      return {
        ...file,
        ...(worktreeStatus ? { worktreeStatus } : {}),
        partiallyStaged: worktreeStatus !== undefined,
      };
    });
    const unstagedCount = [...worktreeEntries.values()].filter((code) => code === '??' || code[1] !== ' ').length;
    const identity = {
      configured: Boolean(name?.stdout && email?.stdout),
      ...(name?.stdout ? { name: name.stdout } : {}),
      ...(email?.stdout ? { email: email.stdout } : {}),
    };
    const blockers: PublishBlocker[] = [];
    if (!branch) blockers.push({ code: 'detached_head', message: 'Check out a branch before publishing.' });
    if (!remoteUrl) blockers.push({ code: 'missing_origin', message: 'Add an origin remote before publishing.' });
    else if (!githubRemote) blockers.push({ code: 'unsupported_remote', message: 'Pull requests currently require a GitHub origin remote.' });
    if (!baseBranch) blockers.push({ code: 'missing_base', message: 'No base branch could be resolved.' });
    if (branch && baseBranch && branch === baseBranch) blockers.push({ code: 'on_base_branch', message: 'Create or check out a feature branch before opening a pull request.' });
    if (!ghVersion) blockers.push({ code: 'gh_missing', message: 'Install GitHub CLI to create pull requests.' });
    else if (!ghAuth) blockers.push({ code: 'gh_unauthenticated', message: 'GitHub CLI authentication is missing or invalid. Run gh auth login --hostname github.com.' });
    if (stagedWithState.length > 0 && !identity.configured) blockers.push({ code: 'missing_identity', message: 'Configure Git user.name and user.email before committing.' });
    if (stagedWithState.length === 0 && ahead === 0) blockers.push({ code: 'nothing_to_publish', message: 'There are no staged changes or branch commits to publish.' });
    if (existingPr) blockers.push({ code: 'existing_pr', message: `Pull request #${existingPr.number} already exists for this branch.` });
    const prBlockingCodes = new Set(blockers.map((blocker) => blocker.code));
    const canCommit = stagedWithState.length > 0 && identity.configured;
    const canCreatePr = !['detached_head', 'missing_origin', 'unsupported_remote', 'missing_base', 'on_base_branch',
      'gh_missing', 'gh_unauthenticated', 'missing_identity', 'nothing_to_publish', 'existing_pr']
      .some((code) => prBlockingCodes.has(code as PublishBlocker['code']));
    return {
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      baseCandidates: candidates,
      ...(remoteUrl ? { remote: { name: 'origin', url: remoteUrl, github: githubRemote } } : {}),
      ...(upstream?.stdout ? { upstream: upstream.stdout } : {}),
      ahead,
      stagedFiles: stagedWithState,
      unstagedCount,
      identity,
      github: {
        state: !ghVersion ? 'missing' : ghAuth ? 'ready' : 'unauthenticated',
        installed: Boolean(ghVersion), authenticated: Boolean(ghAuth),
        ...(account ? { account } : {}),
        detail: !ghVersion
          ? 'GitHub CLI was not found in PATH or a standard installation location.'
          : ghAuth
            ? `Authenticated with GitHub${account ? ` as ${account}` : ''}.`
            : /invalid|token/i.test(ghAuthCheck?.error ?? '')
              ? 'GitHub CLI is installed, but its saved authentication token is invalid.'
              : 'GitHub CLI is installed, but it is not authenticated with github.com.',
      },
      ...(existingPr ? { existingPr } : {}),
      canCommit,
      canCreatePr,
      blockers,
    };
  };

  return {
    status,
    async commit(repoPath, subject, body) {
      const normalizedSubject = subject.trim();
      const normalizedBody = body?.trim();
      if (!normalizedSubject) throw new Error('Commit subject is required.');
      if (normalizedSubject.length > MAX_COMMIT_SUBJECT_LENGTH) throw new Error(`Commit subject must be ${MAX_COMMIT_SUBJECT_LENGTH} characters or fewer.`);
      if (normalizedBody && normalizedBody.length > MAX_PUBLISH_BODY_LENGTH) throw new Error('Commit details are too long.');
      const state = await status(repoPath);
      if (!state.canCommit) throw new Error(state.blockers.find((blocker) => blocker.code === 'missing_identity')?.message ?? 'There are no staged changes to commit.');
      const args = ['commit', '-m', normalizedSubject];
      if (normalizedBody) args.push('-m', normalizedBody);
      await execute(repoPath, 'git', args, 30_000);
      const sha = (await execute(repoPath, 'git', ['rev-parse', '--short', 'HEAD'])).stdout;
      return { sha, subject: normalizedSubject };
    },
    async push(repoPath) {
      const branch = await currentBranch(repoPath);
      if (!branch) throw new Error('Check out a branch before publishing.');
      const origin = await attempt(repoPath, 'git', ['remote', 'get-url', 'origin']);
      if (!origin) throw new Error('Add an origin remote before publishing.');
      await execute(repoPath, 'git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], 120_000);
      return { remote: 'origin', branch, upstream: `origin/${branch}` };
    },
    async createPullRequest(repoPath, input) {
      const title = input.title.trim();
      if (!title) throw new Error('Pull request title is required.');
      if (title.length > MAX_PR_TITLE_LENGTH) throw new Error(`Pull request title must be ${MAX_PR_TITLE_LENGTH} characters or fewer.`);
      if (input.body.length > MAX_PUBLISH_BODY_LENGTH) throw new Error('Pull request description is too long.');
      const state = await status(repoPath);
      if (state.existingPr) throw new Error(`Pull request #${state.existingPr.number} already exists: ${state.existingPr.url}`);
      if (!state.canCreatePr) throw new Error(state.blockers[0]?.message ?? 'Pull request preflight failed.');
      if (!state.baseCandidates.includes(input.base)) throw new Error('Base branch is not available from origin.');
      const args = ['pr', 'create', '--base', input.base, '--head', state.branch!, '--title', title, '--body', input.body];
      if (input.draft) args.push('--draft');
      const created = await execute(repoPath, 'gh', args, 120_000);
      const viewed = await findExistingPr(repoPath, state.branch!);
      if (viewed) return viewed;
      const url = created.stdout.split('\n').find((line) => /^https:\/\//.test(line));
      const number = Number(url?.match(/\/pull\/(\d+)/)?.[1]);
      if (!url || !number) throw new Error('GitHub created the pull request but did not return its URL.');
      return { number, url, title, state: 'OPEN', draft: input.draft };
    },
  };
}

export const gitPublishService = createGitPublishService();
