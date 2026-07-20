import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitPublishService, resolveGitHubExecutable, type CommandRunner } from './publish.js';

function commandKey(command: string, args: string[]): string {
  return `${command} ${args.join(' ')}`;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function publishRunner(overrides: Record<string, string | Error> = {}) {
  const responses: Record<string, string | Error> = {
    'git symbolic-ref --short HEAD': 'feature/publish',
    'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    'git for-each-ref --format=%(refname:short) refs/remotes/origin': 'origin/HEAD\norigin/main',
    'git show-ref --verify --quiet refs/heads/main': '',
    'git remote get-url origin': 'git@github.com:example/project.git',
    'git config --get user.name': 'AgentDeck Test',
    'git config --get user.email': 'agentdeck@example.test',
    'git diff --cached --no-renames --numstat': '3\t1\tsrc/app.ts',
    'git diff --cached --no-renames --name-status': 'M\tsrc/app.ts',
    'git status --porcelain --untracked-files=all': 'MM src/app.ts\n?? notes.txt',
    'git rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
    'gh --version': 'gh version 2.0.0',
    'gh auth status --hostname github.com': 'Logged in',
    'gh api user --jq .login': 'octocat',
    'gh pr view feature/publish --json number,url,title,state,isDraft': new Error('no pull requests found'),
    'git show-ref --verify --quiet refs/remotes/origin/main': '',
    'git rev-list --count origin/main..HEAD': '1',
    ...overrides,
  };
  const runner = vi.fn<CommandRunner>(async (command, args) => {
    const value = responses[commandKey(command, args)];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected command: ${commandKey(command, args)}`);
    return { stdout: value, stderr: '' };
  });
  return runner;
}

describe('GitPublishService status', () => {
  it('reports publish readiness and staged worktree state', async () => {
    const service = createGitPublishService(publishRunner());
    const status = await service.status('/repo');

    expect(status).toMatchObject({
      branch: 'feature/publish', baseBranch: 'main', ahead: 1, unstagedCount: 2,
      identity: { configured: true, name: 'AgentDeck Test', email: 'agentdeck@example.test' },
      github: { state: 'ready', installed: true, authenticated: true, account: 'octocat' },
      canCommit: true, canCreatePr: true,
    });
    expect(status.stagedFiles).toEqual([expect.objectContaining({
      path: 'src/app.ts', staged: true, partiallyStaged: true, worktreeStatus: 'M',
    })]);
  });

  it('allows a local commit while reporting PR-specific blockers', async () => {
    const runner = publishRunner({
      'git remote get-url origin': new Error('no remote'),
      'gh --version': new Error('missing gh'),
      'git rev-list --count origin/main..HEAD': new Error('no remote ref'),
    });
    const status = await createGitPublishService(runner).status('/repo');

    expect(status.canCommit).toBe(true);
    expect(status.canCreatePr).toBe(false);
    expect(status.github).toMatchObject({ state: 'missing', installed: false, authenticated: false });
    expect(status.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(['missing_origin', 'gh_missing']));
  });

  it('distinguishes an invalid GitHub token from a missing CLI', async () => {
    const status = await createGitPublishService(publishRunner({
      'gh auth status --hostname github.com': new Error('The token in default is invalid.'),
    })).status('/repo');

    expect(status.github).toMatchObject({
      state: 'unauthenticated', installed: true, authenticated: false,
      detail: expect.stringMatching(/token is invalid/i),
    });
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'gh_unauthenticated' }));
  });

  it('surfaces an existing pull request instead of allowing a duplicate', async () => {
    const raw = JSON.stringify({ number: 42, url: 'https://github.com/example/project/pull/42', title: 'Existing', state: 'OPEN', isDraft: true });
    const status = await createGitPublishService(publishRunner({
      'gh pr view feature/publish --json number,url,title,state,isDraft': raw,
    })).status('/repo');

    expect(status.existingPr).toMatchObject({ number: 42, draft: true });
    expect(status.canCreatePr).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'existing_pr' }));
  });
});

describe('resolveGitHubExecutable', () => {
  it('finds gh in a standard installation path when PATH is restricted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-gh-'));
    tempDirs.push(root);
    const executable = path.join(root, 'gh');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);

    expect(resolveGitHubExecutable('', [executable])).toBe(executable);
  });
});

describe('GitPublishService mutations', () => {
  it('commits only through git commit and returns the created SHA', async () => {
    const runner = publishRunner({
      'git commit -m Publish changes -m Details': '',
      'git rev-parse --short HEAD': 'abc1234',
    });
    const result = await createGitPublishService(runner).commit('/repo', '  Publish changes  ', ' Details ');

    expect(result).toEqual({ sha: 'abc1234', subject: 'Publish changes' });
    expect(runner).toHaveBeenCalledWith('git', ['commit', '-m', 'Publish changes', '-m', 'Details'], expect.anything());
  });

  it('pushes HEAD to the matching origin branch and sets upstream', async () => {
    const runner = publishRunner({
      'git push --set-upstream origin HEAD:refs/heads/feature/publish': '',
    });
    const result = await createGitPublishService(runner).push('/repo');

    expect(result).toEqual({ remote: 'origin', branch: 'feature/publish', upstream: 'origin/feature/publish' });
  });

  it('creates a draft pull request and returns GitHub metadata', async () => {
    const createdUrl = 'https://github.com/example/project/pull/43';
    const runner = publishRunner({
      'gh pr create --base main --head feature/publish --title Publish changes --body Summary --draft': createdUrl,
    });
    const result = await createGitPublishService(runner).createPullRequest('/repo', {
      base: 'main', title: ' Publish changes ', body: 'Summary', draft: true,
    });

    expect(result).toEqual({ number: 43, url: createdUrl, title: 'Publish changes', state: 'OPEN', draft: true });
  });

  it('commits the staged snapshot while preserving later unstaged edits', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-publish-'));
    tempDirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.name', 'AgentDeck Test');
    git('config', 'user.email', 'agentdeck@example.test');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-m', 'fixture');
    git('branch', '-M', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\nstaged\n');
    git('add', 'README.md');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\nstaged\nunstaged\n');

    const result = await createGitPublishService().commit(repo, 'Publish staged work');

    expect(result.subject).toBe('Publish staged work');
    expect(git('show', 'HEAD:README.md')).toBe('base\nstaged');
    expect(git('diff', '--', 'README.md')).toContain('+unstaged');
  }, 15_000);
});
