import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, describe, expect, it,
} from 'vitest';
import {
  buildRepairObjective, createShellVerificationGateRunner, freezeVerificationPolicy,
} from './verification.js';
import type { RepositoryVerificationPolicy } from './types.js';

describe('freezeVerificationPolicy', () => {
  it('surfaces missing configuration with a precise reason rather than treating it as unverified (AC8)', () => {
    const frozen = freezeVerificationPolicy(undefined);
    expect(frozen.state).toBe('missing');
    if (frozen.state !== 'missing') throw new Error('expected missing');
    expect(frozen.reason).toContain('No verification configuration is approved');
  });

  it('freezes an explicit no-verification declaration distinctly from missing configuration (AC7)', () => {
    const policy: RepositoryVerificationPolicy = { kind: 'no-verification' };
    expect(freezeVerificationPolicy(policy)).toEqual({ state: 'declared-unverified' });
  });

  it('freezes required gates exactly as approved', () => {
    const policy: RepositoryVerificationPolicy = {
      kind: 'required',
      gates: [{ name: 'tests', command: 'npm test' }],
    };
    expect(freezeVerificationPolicy(policy)).toEqual({
      state: 'ready',
      requiredGates: [{ name: 'tests', command: 'npm test' }],
    });
  });
});

describe('buildRepairObjective', () => {
  it('states the failing gate, its exact command, and concise evidence — never a vague instruction', () => {
    const objective = buildRepairObjective('Add a feature', [
      {
        gate: { name: 'tests', command: 'npm test' },
        required: true,
        result: { passed: false, exitCode: 1, evidence: '1 failing: expected 2 to equal 3' },
      },
    ]);

    expect(objective).toContain('Add a feature');
    expect(objective).toContain('tests');
    expect(objective).toContain('npm test');
    expect(objective).toContain('exited 1');
    expect(objective).toContain('expected 2 to equal 3');
  });
});

describe('createShellVerificationGateRunner', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function tempDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-verification-'));
    tempDirectories.push(directory);
    return directory;
  }

  it('reports a passing gate with its output as evidence', async () => {
    const runner = createShellVerificationGateRunner();
    const worktree = tempDir();

    const result = await runner({ name: 'echo', command: 'echo ok' }, worktree);

    expect(result).toEqual({ passed: true, exitCode: 0, evidence: 'ok' });
  });

  it('reports a failing gate with its exit code and combined output as concise evidence', async () => {
    const runner = createShellVerificationGateRunner();
    const worktree = tempDir();

    const result = await runner({ name: 'fail', command: 'echo boom 1>&2; exit 7' }, worktree);

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.evidence).toContain('boom');
  });

  it('runs the command inside the given worktree', async () => {
    const runner = createShellVerificationGateRunner();
    const worktree = tempDir();
    fs.writeFileSync(path.join(worktree, 'marker.txt'), 'here\n');

    const result = await runner({ name: 'ls', command: 'cat marker.txt' }, worktree);

    expect(result).toEqual({ passed: true, exitCode: 0, evidence: 'here' });
  });

  it('kills a command that exceeds its timeout and reports it as a failing gate, never hanging the Run', async () => {
    const runner = createShellVerificationGateRunner(50);
    const worktree = tempDir();

    const result = await runner({ name: 'hang', command: 'sleep 5' }, worktree);

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('Timed out after 50ms');
  });
});
