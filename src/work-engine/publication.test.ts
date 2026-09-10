// Ticket 13: the reconcile-then-execute orchestrator (executePublication)
// against a scripted RunPublisher, and the real git-backed publisher
// against a local bare "origin". Push and pull-request creation are the
// only external effects AgentDeck ever performs on a Run's behalf, so every
// branch of "did it happen?" is pinned here: divergence both ways, a
// repeated command, a network failure before and after a command was sent,
// and an outcome that cannot be proven either way.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand, type CommandRunner } from '../git/publish.js';
import { createScriptedSequence } from '../test-fixtures/scripted-sequence.js';
import {
  buildPullRequestInput, createGitRunPublisher, pullRequestBase,
} from './publication-git.js';
import {
  executePublication, redactRemoteUrl, redactSecrets, RemoteUnobservableError,
} from './publication.js';
import type { RemoteObservation, RunPublisher } from './publication.js';
import type { RunPublication, WorkRun } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-publication-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function intent(overrides: Partial<RunPublication> = {}): RunPublication {
  return {
    id: 'pub-1',
    runId: 'run-1',
    idempotencyKey: 'run:run-1:commit:aaa111',
    target: 'draft-pull-request',
    commit: 'aaa111',
    branch: 'agentdeck/run/run-1',
    state: 'executing',
    authorizedBy: { id: 'local:admin', displayName: 'admin' },
    authorizedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    executions: 1,
    ...overrides,
  };
}

const context = {
  worktreePath: '/runs/run-1',
  pullRequest: { base: 'main', title: 'Publish me', body: 'body' },
};

const pullRequest = { number: 7, url: 'https://github.com/example/project/pull/7', title: 'Publish me', draft: true };

/** A scripted publisher: `observations` are consumed in order by successive observe() calls (a function may throw); the last one repeats. */
function fakePublisher(script: {
  head?: { commit: string; branch?: string } | Error;
  observations: Array<RemoteObservation | Error>;
  push?: Error;
  createPullRequest?: Error;
}) {
  const nextObservation = createScriptedSequence<RemoteObservation | Error>(script.observations);
  const publisher: RunPublisher = {
    localHead: vi.fn(async () => {
      if (script.head instanceof Error) throw script.head;
      return script.head ?? { commit: 'aaa111', branch: 'agentdeck/run/run-1' };
    }),
    observe: vi.fn(async () => {
      const value = nextObservation();
      if (value instanceof Error) throw value;
      return value;
    }),
    push: vi.fn(async () => {
      if (script.push) throw script.push;
    }),
    createDraftPullRequest: vi.fn(async () => {
      if (script.createPullRequest) throw script.createPullRequest;
      return pullRequest;
    }),
  };
  return publisher;
}

const absent: RemoteObservation = { remoteUrl: 'git@github.com:example/project.git' };
const pushed: RemoteObservation = { ...absent, remoteCommit: 'aaa111' };
const published: RemoteObservation = { ...pushed, pullRequest };

describe('executePublication', () => {
  it('pushes and opens a draft pull request when origin has neither, recording remote, branch, commit, and pull request (AC4)', async () => {
    const publisher = fakePublisher({ observations: [absent] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({
      state: 'succeeded',
      result: { remote: { name: 'origin', url: absent.remoteUrl }, branch: 'agentdeck/run/run-1', commit: 'aaa111', pullRequest },
    });
    expect(publisher.push).toHaveBeenCalledWith('/runs/run-1', 'aaa111', 'agentdeck/run/run-1');
    expect(publisher.createDraftPullRequest).toHaveBeenCalledWith('/runs/run-1', context.pullRequest);
  });

  it('only pushes for a push target — never a pull request, and never asks GitHub about one', async () => {
    const publisher = fakePublisher({ observations: [absent] });
    const outcome = await executePublication(publisher, intent({ target: 'push' }), context, { priorExecution: false });
    expect(outcome).toMatchObject({ state: 'succeeded', result: { commit: 'aaa111' } });
    expect(outcome.state === 'succeeded' && outcome.result.pullRequest).toBeUndefined();
    expect(publisher.observe).toHaveBeenCalledWith('/runs/run-1', 'agentdeck/run/run-1', { pullRequest: false });
    expect(publisher.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('is idempotent: when origin already has the commit and an open pull request, nothing is sent again (repeated command / restart)', async () => {
    const publisher = fakePublisher({ observations: [published] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: true });
    expect(outcome).toMatchObject({ state: 'succeeded', result: { pullRequest } });
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('resumes past an already-landed push and only creates the missing pull request', async () => {
    const publisher = fakePublisher({ observations: [pushed] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: true });
    expect(outcome.state).toBe('succeeded');
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.createDraftPullRequest).toHaveBeenCalledTimes(1);
  });

  it('fails without pushing when the worktree is on a different branch at the same commit (Git divergence, local branch mismatch)', async () => {
    const publisher = fakePublisher({ head: { commit: 'aaa111', branch: 'some-other-branch' }, observations: [absent] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringMatching(/some-other-branch.*not the authorized branch/) });
    expect(publisher.observe).not.toHaveBeenCalled();
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('fails without pushing when the local branch has moved off the authorized commit (Git divergence, local)', async () => {
    const publisher = fakePublisher({ head: { commit: 'bbb222', branch: 'agentdeck/run/run-1' }, observations: [absent] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('bbb222') });
    expect(publisher.observe).not.toHaveBeenCalled();
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('fails without pushing when origin already has the branch at a different commit — never force-pushes (Git divergence, remote)', async () => {
    const publisher = fakePublisher({ observations: [{ ...absent, remoteCommit: 'ccc333' }] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringMatching(/ccc333.*never force-pushes/) });
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('fails plainly when origin is unreachable before anything was ever sent (network failure, first attempt)', async () => {
    const publisher = fakePublisher({ observations: [new RemoteUnobservableError('Could not resolve host: github.com')] });
    const outcome = await executePublication(publisher, intent({ state: 'authorized', executions: 0 }), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('nothing was published') });
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('is ambiguous when origin is unreachable and an earlier execution may already have pushed (restart into a network failure)', async () => {
    const publisher = fakePublisher({ observations: [new RemoteUnobservableError('Could not resolve host: github.com')] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: true });
    expect(outcome).toEqual({ state: 'ambiguous', reason: expect.stringContaining('earlier attempt') });
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('fails when the push is refused and origin confirms the branch is still absent', async () => {
    const publisher = fakePublisher({ observations: [absent, absent], push: new Error('remote: permission denied') });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('permission denied') });
    expect(publisher.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('treats a push whose command failed but whose commit origin now reports as landed, and carries on', async () => {
    const publisher = fakePublisher({ observations: [absent, pushed], push: new Error('timed out') });
    const outcome = await executePublication(publisher, intent({ target: 'push' }), context, { priorExecution: false });
    expect(outcome.state).toBe('succeeded');
  });

  it('is ambiguous when the push command fails and origin cannot be observed afterward (ambiguous outcome)', async () => {
    const publisher = fakePublisher({
      observations: [absent, new RemoteUnobservableError('connection reset')], push: new Error('timed out'),
    });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'ambiguous', reason: expect.stringMatching(/timed out.*could not be observed afterward/) });
    expect(publisher.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('fails (with the branch pushed) when the pull request cannot be created and GitHub confirms none exists', async () => {
    const publisher = fakePublisher({ observations: [absent, pushed], createPullRequest: new Error('gh: base branch is not available') });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringMatching(/branch was pushed.*base branch/) });
  });

  it('is ambiguous when the pull request command fails and GitHub cannot be observed afterward', async () => {
    const publisher = fakePublisher({
      observations: [absent, new RemoteUnobservableError('api.github.com unreachable')], createPullRequest: new Error('gh: timeout'),
    });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toEqual({ state: 'ambiguous', reason: expect.stringContaining('could not be observed afterward') });
  });

  it('recovers a pull request that GitHub created despite the command reporting failure', async () => {
    const publisher = fakePublisher({ observations: [absent, published], createPullRequest: new Error('gh: timeout') });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome).toMatchObject({ state: 'succeeded', result: { pullRequest } });
  });

  it('never lets a credential from a command error into a durable reason (secret redaction)', async () => {
    const publisher = fakePublisher({
      observations: [absent, absent],
      push: new Error("fatal: unable to access 'https://octocat:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/example/project.git/'"),
    });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: false });
    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(outcome.state === 'failed' && outcome.reason).not.toContain('octocat:');
  });

  it('reports a missing origin remote as a definite failure, not an ambiguous one', async () => {
    const publisher = fakePublisher({ observations: [new Error('Add an origin remote before publishing.')] });
    const outcome = await executePublication(publisher, intent(), context, { priorExecution: true });
    expect(outcome).toEqual({ state: 'failed', reason: 'Add an origin remote before publishing.' });
  });
});

describe('redaction helpers', () => {
  it('strips userinfo from remote URLs and token-shaped values from text', () => {
    expect(redactRemoteUrl('https://user:ghp_secret@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(redactRemoteUrl('git@github.com:example/project.git')).toBe('git@github.com:example/project.git');
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz1234 leaked')).toBe('token *** leaked');
    expect(redactSecrets('github_pat_11ABCDEFG0123456789abcdef leaked')).toBe('*** leaked');
  });
});

describe('pull request input', () => {
  const run = {
    id: 'run-1',
    principal: { id: 'collab-1', displayName: 'Alice' },
    spec: {
      objective: 'Fix the flaky login test',
      acceptanceCriteria: ['The test passes reliably', 'No new warnings'],
      requestedBaseReference: 'refs/heads/main',
    },
  } as unknown as WorkRun;

  it('derives the base branch from the frozen requestedBaseReference', () => {
    expect(pullRequestBase('refs/heads/main')).toBe('main');
    expect(pullRequestBase('develop')).toBe('develop');
  });

  it('builds a title from the objective and a body naming criteria, Run, Principal, and authorizer', () => {
    const input = buildPullRequestInput(run, intent());
    expect(input.base).toBe('main');
    expect(input.title).toBe('Fix the flaky login test');
    expect(input.body).toContain('- The test passes reliably');
    expect(input.body).toContain('AgentDeck-Run: run-1');
    expect(input.body).toContain('AgentDeck-Principal: Alice (collab-1)');
    expect(input.body).toContain('AgentDeck-Published-By: admin (local:admin)');
  });
});

// The real port, against a local bare origin. gh is stubbed at the
// CommandRunner seam (it is never installed in CI); git is real.
describe('createGitRunPublisher', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function setUp() {
    const root = tempDir();
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '--bare', origin);
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    git(work, 'init');
    git(work, 'config', 'user.email', 'agentdeck@example.test');
    git(work, 'config', 'user.name', 'AgentDeck Test');
    fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
    git(work, 'add', 'README.md');
    git(work, 'commit', '-m', 'fixture');
    git(work, 'branch', '-M', 'main');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', 'origin', 'main');
    git(work, 'checkout', '-b', 'agentdeck/run/run-1');
    fs.writeFileSync(path.join(work, 'change.txt'), 'hello\n');
    git(work, 'add', 'change.txt');
    git(work, 'commit', '-m', 'change');
    const commit = git(work, 'rev-parse', 'HEAD');
    return { root, origin, work, commit };
  }

  function ghStub(responses: Record<string, string | Error>): CommandRunner {
    return async (command, args, options) => {
      if (command !== 'gh') return runCommand(command, args, options);
      const key = args.join(' ');
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      if (!match) throw new Error(`unexpected gh command: ${key}`);
      if (match[1] instanceof Error) throw match[1];
      return { stdout: match[1], stderr: '' };
    };
  }

  it('reads the local head, observes an absent then present remote branch, and pushes exactly the commit', async () => {
    const { work, origin, commit } = setUp();
    const publisher = createGitRunPublisher();

    expect(await publisher.localHead(work)).toEqual({ commit, branch: 'agentdeck/run/run-1' });
    expect(await publisher.observe(work, 'agentdeck/run/run-1', { pullRequest: false })).toEqual({ remoteUrl: origin });

    await publisher.push(work, commit, 'agentdeck/run/run-1');

    expect(await publisher.observe(work, 'agentdeck/run/run-1', { pullRequest: false })).toEqual({ remoteUrl: origin, remoteCommit: commit });
    expect(git(origin, 'rev-parse', 'refs/heads/agentdeck/run/run-1')).toBe(commit);
  });

  it('refuses to touch a remote branch that already exists, even when the push would fast-forward it (Git divergence at the git layer)', async () => {
    const { work, origin, commit } = setUp();
    const publisher = createGitRunPublisher();
    // Someone else creates the branch name on origin first (at main, an
    // ancestor — the one case a plain non-forced push would silently accept).
    git(work, 'push', 'origin', 'main:refs/heads/agentdeck/run/run-1');

    await expect(publisher.push(work, commit, 'agentdeck/run/run-1')).rejects.toThrow(/stale info|rejected/);
    expect(git(origin, 'rev-parse', 'refs/heads/agentdeck/run/run-1')).toBe(git(work, 'rev-parse', 'main'));
  });

  it('raises RemoteUnobservableError when origin cannot be reached, and a plain error when there is no origin at all', async () => {
    const { work, root } = setUp();
    const publisher = createGitRunPublisher();
    git(work, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'));
    await expect(publisher.observe(work, 'agentdeck/run/run-1', { pullRequest: false })).rejects.toBeInstanceOf(RemoteUnobservableError);

    git(work, 'remote', 'remove', 'origin');
    await expect(publisher.observe(work, 'agentdeck/run/run-1', { pullRequest: false })).rejects.toThrow('Add an origin remote');
  });

  it('redacts credentials embedded in the origin URL before reporting it', async () => {
    const { work } = setUp();
    git(work, 'remote', 'set-url', 'origin', 'https://octocat:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/example/project.git');
    const publisher = createGitRunPublisher(ghStub({}));
    // ls-remote against github.com will fail here (no network/auth) — the
    // URL itself is what this test is about, so read it off the error path
    // via a runner that answers ls-remote locally instead.
    const runner: CommandRunner = async (command, args, options) => (
      command === 'git' && args[0] === 'ls-remote' ? { stdout: '', stderr: '' } : runCommand(command, args, options)
    );
    const observation = await createGitRunPublisher(runner).observe(work, 'agentdeck/run/run-1', { pullRequest: false });
    expect(observation.remoteUrl).toBe('https://***@github.com/example/project.git');
    expect(publisher).toBeDefined();
  });

  it('looks up an open pull request for the branch through gh, treating an empty list as absent and a gh failure as unobservable', async () => {
    const { work, origin } = setUp();
    const listed = createGitRunPublisher(ghStub({
      'pr list --head agentdeck/run/run-1': JSON.stringify([{ number: 7, url: 'https://github.com/example/project/pull/7', title: 'Publish me', isDraft: true }]),
    }));
    expect(await listed.observe(work, 'agentdeck/run/run-1', { pullRequest: true })).toEqual({
      remoteUrl: origin,
      pullRequest: { number: 7, url: 'https://github.com/example/project/pull/7', title: 'Publish me', draft: true },
    });

    const empty = createGitRunPublisher(ghStub({ 'pr list --head agentdeck/run/run-1': '[]' }));
    expect(await empty.observe(work, 'agentdeck/run/run-1', { pullRequest: true })).toEqual({ remoteUrl: origin });

    const broken = createGitRunPublisher(ghStub({ 'pr list --head agentdeck/run/run-1': new Error('error connecting to api.github.com') }));
    await expect(broken.observe(work, 'agentdeck/run/run-1', { pullRequest: true })).rejects.toBeInstanceOf(RemoteUnobservableError);
  });

  it('creates the draft pull request through the existing GitPublishService preflight — a non-GitHub origin is refused there, unchanged', async () => {
    const { work } = setUp();
    const publisher = createGitRunPublisher(ghStub({ '--version': 'gh version 2.0.0', 'auth status': 'ok', 'api user': 'octocat' }));
    await expect(publisher.createDraftPullRequest(work, { base: 'main', title: 'Publish me', body: 'body' }))
      .rejects.toThrow(/GitHub origin remote/);
  });
});
