import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeReadinessReport } from '../sessions/runtime-readiness-contract.js';
import {
  assertChildRunCeiling,
  assertNetworkDomainAllowed,
  assertProcessCeiling,
  assertReadablePath,
  assertSecretGrantAccess,
  assertWritablePath,
  buildRunEnvelope,
  CapabilityEnvelopeViolation,
  CHILD_RUN_CEILING,
  filterEnvironment,
  MANAGED_ENVIRONMENT_ALLOWLIST,
  TRUSTED_RUNTIME_PROVIDER_DOMAINS,
} from './envelope.js';
import type { CapabilityEnvelope, EnvelopeProfile } from './types.js';

function readiness(overrides: Partial<RuntimeReadinessReport['runtimes'][number]>[] = []): RuntimeReadinessReport {
  const base: RuntimeReadinessReport['runtimes'] = [
    {
      runtime: 'codex',
      displayName: 'Codex CLI',
      status: 'managed',
      reason: 'All managed-run capabilities are available.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        { capability: 'execution-restrictions', supported: true },
      ],
    },
    {
      runtime: 'claude',
      displayName: 'Claude Code',
      status: 'compatibility-only',
      reason: 'Missing managed-run capabilities: execution restrictions.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        { capability: 'execution-restrictions', supported: false, reason: 'not exposed' },
      ],
    },
  ];
  const runtimes = base.map((runtime) => {
    const override = overrides.find((candidate) => candidate.runtime === runtime.runtime);
    return override ? { ...runtime, ...override } : runtime;
  });
  return { checkedAt: '2026-09-01T00:00:00.000Z', runtimes };
}

describe('buildRunEnvelope', () => {
  it('freezes a ready envelope for the first preferred runtime that can satisfy it', () => {
    const state = buildRunEnvelope({
      runtimePreference: ['codex', 'claude'],
      readiness: readiness(),
      worktreePath: '/runs/abc/worktree',
    });

    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('expected ready');
    expect(state.capabilityEnvelope.runtime).toBe('codex');
    expect(state.capabilityEnvelope.profile).toEqual({
      writableWorktree: '/runs/abc/worktree',
      readableRoots: ['/runs/abc/worktree'],
      allowedNetworkDomains: TRUSTED_RUNTIME_PROVIDER_DOMAINS.codex,
      environmentAllowlist: MANAGED_ENVIRONMENT_ALLOWLIST,
      processCeiling: expect.any(Number),
      childRunCeiling: CHILD_RUN_CEILING,
    });
    expect(state.capabilityEnvelope.secretGrants).toEqual([]);
  });

  it('skips a preferred runtime that cannot satisfy the envelope and pins the next eligible one', () => {
    const state = buildRunEnvelope({
      runtimePreference: ['claude', 'codex'],
      readiness: readiness(),
      worktreePath: '/runs/abc/worktree',
    });

    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('expected ready');
    expect(state.capabilityEnvelope.runtime).toBe('codex');
    expect(state.capabilityEnvelope.profile.allowedNetworkDomains).toBe(TRUSTED_RUNTIME_PROVIDER_DOMAINS.codex);
  });

  it('refuses managed status with a precise reason rather than degrading when no preferred runtime qualifies', () => {
    const state = buildRunEnvelope({
      runtimePreference: ['claude'],
      readiness: readiness(),
      worktreePath: '/runs/abc/worktree',
    });

    expect(state.state).toBe('refused');
    if (state.state !== 'refused') throw new Error('expected refused');
    expect(state.reason).toContain('Claude Code');
    expect(state.reason).toContain('execution restrictions');
  });

  it('refuses when a runtime is otherwise managed but cannot enforce execution restrictions', () => {
    const state = buildRunEnvelope({
      runtimePreference: ['claude'],
      readiness: readiness([{
        runtime: 'claude',
        status: 'managed',
        reason: 'All managed-run capabilities are available.',
        capabilities: [
          { capability: 'structured-events', supported: true },
          { capability: 'continuation', supported: true },
          { capability: 'approvals', supported: true },
          { capability: 'usage-reporting', supported: true },
          { capability: 'execution-restrictions', supported: false, reason: 'not exposed' },
        ],
      }]),
      worktreePath: '/runs/abc/worktree',
    });

    expect(state.state).toBe('refused');
    if (state.state !== 'refused') throw new Error('expected refused');
    expect(state.reason).toContain('execution restrictions unsupported');
  });

  it('refuses when a preferred runtime has no readiness evidence at all', () => {
    const state = buildRunEnvelope({
      runtimePreference: ['codex'],
      readiness: { checkedAt: '2026-09-01T00:00:00.000Z', runtimes: [] },
      worktreePath: '/runs/abc/worktree',
    });

    expect(state.state).toBe('refused');
    if (state.state !== 'refused') throw new Error('expected refused');
    expect(state.reason).toContain('no readiness evidence');
  });

  it('accepts secret grants only as redacted references, never raw values', () => {
    const ready = buildRunEnvelope({
      runtimePreference: ['codex'],
      readiness: readiness(),
      worktreePath: '/runs/abc/worktree',
      secretGrants: [{ name: 'github-token', reference: 'secret-ref:github-token-1' }],
    });
    expect(ready.state).toBe('ready');
    if (ready.state !== 'ready') throw new Error('expected ready');
    expect(ready.capabilityEnvelope.secretGrants).toEqual([{ name: 'github-token', reference: 'secret-ref:github-token-1' }]);

    expect(() => buildRunEnvelope({
      runtimePreference: ['codex'],
      readiness: readiness(),
      worktreePath: '/runs/abc/worktree',
      secretGrants: [{ name: 'github-token', reference: 'ghp_actualRawSecretValue1234567890' }],
    })).toThrow(CapabilityEnvelopeViolation);
  });

  it('the first-release child-Run ceiling is zero', () => {
    expect(CHILD_RUN_CEILING).toBe(0);
  });
});

describe('capability envelope enforcement against a hostile fixture', () => {
  const tempDirectories: string[] = [];
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function makeWorktree(): { worktreePath: string; outsidePath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-envelope-'));
    tempDirectories.push(root);
    const worktreePath = path.join(root, 'worktree');
    const outsidePath = path.join(root, 'outside');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
    return { worktreePath, outsidePath };
  }

  function profileFor(worktreePath: string): EnvelopeProfile {
    return {
      writableWorktree: worktreePath,
      readableRoots: [worktreePath],
      allowedNetworkDomains: TRUSTED_RUNTIME_PROVIDER_DOMAINS.codex,
      environmentAllowlist: MANAGED_ENVIRONMENT_ALLOWLIST,
      processCeiling: 2,
      childRunCeiling: CHILD_RUN_CEILING,
    };
  }

  it('cannot write outside the worktree via a relative traversal', () => {
    const { worktreePath } = makeWorktree();
    const profile = profileFor(worktreePath);

    expect(() => assertWritablePath(profile, path.join(worktreePath, '..', 'outside', 'evil.txt')))
      .toThrow(CapabilityEnvelopeViolation);
    expect(() => assertWritablePath(profile, path.join(worktreePath, 'src', 'ok.ts'))).not.toThrow();
  });

  it('cannot write outside the worktree via an absolute path', () => {
    const { worktreePath, outsidePath } = makeWorktree();
    const profile = profileFor(worktreePath);

    expect(() => assertWritablePath(profile, path.join(outsidePath, 'evil.txt'))).toThrow(CapabilityEnvelopeViolation);
  });

  it('cannot write outside the worktree through a symlink planted inside it', () => {
    const { worktreePath, outsidePath } = makeWorktree();
    const profile = profileFor(worktreePath);
    const escapeLink = path.join(worktreePath, 'escape');
    fs.symlinkSync(outsidePath, escapeLink);

    expect(() => assertWritablePath(profile, path.join(escapeLink, 'evil.txt'))).toThrow(CapabilityEnvelopeViolation);
  });

  it('cannot read outside the granted roots', () => {
    const { worktreePath, outsidePath } = makeWorktree();
    fs.writeFileSync(path.join(outsidePath, 'secret.txt'), 'nope');
    const profile = profileFor(worktreePath);

    expect(() => assertReadablePath(profile, path.join(outsidePath, 'secret.txt'))).toThrow(CapabilityEnvelopeViolation);
  });

  it('cannot use ungranted network access, including a domain-suffix spoof', () => {
    const profile = profileFor(makeWorktree().worktreePath);

    expect(() => assertNetworkDomainAllowed(profile, 'evil.example.com')).toThrow(CapabilityEnvelopeViolation);
    expect(() => assertNetworkDomainAllowed(profile, 'api.openai.com.attacker.com')).toThrow(CapabilityEnvelopeViolation);
    expect(() => assertNetworkDomainAllowed(profile, 'api.openai.com')).not.toThrow();
    expect(() => assertNetworkDomainAllowed(profile, 'eu.api.openai.com')).not.toThrow();
  });

  it('cannot exceed the process ceiling', () => {
    const profile = profileFor(makeWorktree().worktreePath);

    expect(() => assertProcessCeiling(profile, 0)).not.toThrow();
    expect(() => assertProcessCeiling(profile, 1)).not.toThrow();
    expect(() => assertProcessCeiling(profile, 2)).toThrow(CapabilityEnvelopeViolation);
  });

  it('cannot launch any child Run under the first-release zero ceiling', () => {
    const profile = profileFor(makeWorktree().worktreePath);

    expect(() => assertChildRunCeiling(profile, 0)).toThrow(CapabilityEnvelopeViolation);
  });

  it('cannot read an ungranted secret grant', () => {
    const envelope: CapabilityEnvelope = {
      runtime: 'codex',
      profile: profileFor(makeWorktree().worktreePath),
      secretGrants: [{ name: 'github-token', reference: 'secret-ref:github-token-1' }],
    };

    expect(assertSecretGrantAccess(envelope, 'github-token')).toEqual({
      name: 'github-token', reference: 'secret-ref:github-token-1',
    });
    expect(() => assertSecretGrantAccess(envelope, 'aws-key')).toThrow(CapabilityEnvelopeViolation);
  });

  it('does not inherit arbitrary shell environment variables', () => {
    const profile = profileFor(makeWorktree().worktreePath);
    const hostEnv = {
      PATH: '/usr/bin', HOME: '/home/user',
      SECRET_API_KEY: 'sk-should-never-appear', AWS_SECRET_ACCESS_KEY: 'also-should-never-appear',
    };

    const filtered = filterEnvironment(profile, hostEnv);

    expect(filtered).toEqual({ PATH: '/usr/bin', HOME: '/home/user' });
    expect(filtered.SECRET_API_KEY).toBeUndefined();
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
