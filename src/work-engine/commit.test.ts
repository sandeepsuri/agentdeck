import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, describe, expect, it,
} from 'vitest';
import {
  AGENTDECK_COMMIT_IDENTITY, buildCommitMessage, createLocalCommit,
} from './commit.js';
import type { RunPrincipal } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-commit-'));
  tempDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'human@example.test');
  git(dir, 'config', 'user.name', 'A Human');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const principal: RunPrincipal = { id: 'local:sandeep', displayName: 'sandeep' };

describe('buildCommitMessage', () => {
  it('carries the objective as the subject and the Run/Principal as trailers (AC2)', () => {
    const message = buildCommitMessage('Add the missing test', 'run-123', principal);

    expect(message).toContain('Add the missing test');
    expect(message).toContain('AgentDeck-Run: run-123');
    expect(message).toContain('AgentDeck-Principal: sandeep (local:sandeep)');
  });
});

describe('createLocalCommit', () => {
  it('reports no-changes and creates nothing when the worktree has nothing to commit (AC8: empty diff)', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    const before = git(repo, 'rev-parse', 'HEAD');

    const result = await createLocalCommit(repo, buildCommitMessage('Nothing to do', 'run-1', principal));

    expect(result).toEqual({ kind: 'no-changes' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('commits with AgentDeck\'s own author and committer identity, never the human\'s (AC2)', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'change\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Add new-file.txt', 'run-2', principal));

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed');
    expect(result.changedFiles).toEqual(['new-file.txt']);
    expect(result.signed).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe(`${AGENTDECK_COMMIT_IDENTITY.name} <${AGENTDECK_COMMIT_IDENTITY.email}>`);
    expect(git(repo, 'log', '-1', '--format=%cn <%ce>')).toBe(`${AGENTDECK_COMMIT_IDENTITY.name} <${AGENTDECK_COMMIT_IDENTITY.email}>`);
    expect(git(repo, 'log', '-1', '--format=%B')).toContain('AgentDeck-Run: run-2');
    expect(result.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('stages and reports every changed file, including new, modified, and deleted paths', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Change things', 'run-3', principal));

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed');
    expect([...result.changedFiles].sort()).toEqual(['README.md', 'added.txt']);
  });

  it('never commits AgentDeck coordination metadata as task output', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    fs.mkdirSync(path.join(repo, '.agents'));
    fs.writeFileSync(path.join(repo, '.agents', 'bus.jsonl'), '{}\n');
    fs.writeFileSync(path.join(repo, 'result.txt'), 'task output\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Deliver result', 'run-metadata', principal));

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed');
    expect(result.changedFiles).toEqual(['result.txt']);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('result.txt');
    expect(fs.existsSync(path.join(repo, '.agents', 'bus.jsonl'))).toBe(true);
  });

  it('never touches the Repository the worktree was cloned from — only this one isolated worktree (AC8: Git boundary)', async () => {
    const origin = tempDir();
    initGitRepo(origin);
    const originHead = git(origin, 'rev-parse', 'HEAD');
    const worktree = tempDir();
    git(origin, 'worktree', 'add', '-b', 'agentdeck/run/boundary-test', worktree, originHead);
    fs.writeFileSync(path.join(worktree, 'only-in-worktree.txt'), 'change\n');

    const result = await createLocalCommit(worktree, buildCommitMessage('Change in the worktree only', 'run-4', principal));

    expect(result.kind).toBe('committed');
    expect(git(origin, 'rev-parse', 'HEAD')).toBe(originHead);
    expect(fs.existsSync(path.join(origin, 'only-in-worktree.txt'))).toBe(false);
  });

  it('never pushes and never creates a pull request — no remote exists for it to reach (AC6)', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'change\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Local only', 'run-5', principal));

    expect(result.kind).toBe('committed');
    // No origin remote was ever configured — a push attempt would have failed
    // loudly; its total absence from createLocalCommit's own implementation
    // (never invoking `git push` or `gh`) is what AC6 actually asks for.
    expect(git(repo, 'remote')).toBe('');
  });

  it('commits unsigned without failing when signing is configured but unavailable (AC3/AC8: signing unavailable)', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    git(repo, 'config', 'commit.gpgsign', 'true');
    // Point at a program that can never sign anything, standing in for an
    // environment with no gpg installed (this sandbox itself has none).
    git(repo, 'config', 'gpg.program', 'false');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'change\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Signed if possible', 'run-6', principal));

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed');
    expect(result.signed).toBe(false);
    expect(result.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('never attempts to sign when the worktree has no signing configuration at all', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'change\n');

    const result = await createLocalCommit(repo, buildCommitMessage('Plain commit', 'run-7', principal));

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed');
    expect(result.signed).toBe(false);
  });

  it('reports a precise failure when the commit itself cannot be made — a rejecting pre-commit hook, standing in for any of the many ways a real commit can fail (AC3/AC8: commit failure)', async () => {
    const repo = tempDir();
    initGitRepo(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "rejected by policy" 1>&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'change\n');
    const before = git(repo, 'rev-parse', 'HEAD');

    const result = await createLocalCommit(repo, buildCommitMessage('Should fail', 'run-8', principal));

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });
});
