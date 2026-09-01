// The baseline managed capability envelope (ticket 04): an admin-approved
// Profile that AgentDeck freezes for a Run's chosen runtime before that
// runtime receives any authority, plus the guards that enforce it. Building
// on ticket 01's 'execution-restrictions' readiness evidence and ticket 03's
// prepared worktree, a runtime that cannot satisfy the envelope is refused
// managed status here rather than silently degraded.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentType } from '../types.js';
import type { RuntimeReadinessReport } from '../sessions/runtime-readiness-contract.js';
import type {
  CapabilityEnvelope, EnvelopeProfile, RunEnvelopeState, SecretGrant,
} from './types.js';

export class CapabilityEnvelopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityEnvelopeViolation';
  }
}

/** The only host shell variables a managed Run's process may inherit — every other variable is dropped. */
export const MANAGED_ENVIRONMENT_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL',
]);

/** Trusted runtime provider connectivity each managed runtime needs — the only network access granted by default. */
export const TRUSTED_RUNTIME_PROVIDER_DOMAINS: Readonly<Record<AgentType, readonly string[]>> = Object.freeze({
  codex: Object.freeze(['api.openai.com', 'chatgpt.com']),
  claude: Object.freeze(['api.anthropic.com', 'console.anthropic.com']),
});

export const DEFAULT_PROCESS_CEILING = 16;

// First-release ceiling: zero until a runtime can surface and constrain
// every child Run before it executes. No installed runtime does yet, so
// this stays zero regardless of what a Run's budget requests.
export const CHILD_RUN_CEILING = 0;

const SECRET_REFERENCE_PATTERN = /^secret-ref:[A-Za-z0-9._-]+$/;

function assertRedactedSecretReference(grant: SecretGrant): void {
  if (!SECRET_REFERENCE_PATTERN.test(grant.reference)) {
    throw new CapabilityEnvelopeViolation(
      `Secret grant "${grant.name}" must carry a redacted reference (secret-ref:<id>), not a raw value.`,
    );
  }
}

export interface BuildRunEnvelopeOptions {
  readonly runtimePreference: readonly AgentType[];
  readonly readiness: RuntimeReadinessReport;
  readonly worktreePath: string;
  readonly secretGrants?: readonly SecretGrant[];
}

/**
 * Freezes the capability envelope for the first Run-preferred runtime whose
 * readiness evidence proves it can enforce execution restrictions. Preferred
 * runtimes are tried in order; if none qualify the Run is refused managed
 * status with every runtime's precise reason, never silently downgraded.
 */
export function buildRunEnvelope(options: BuildRunEnvelopeOptions): RunEnvelopeState {
  const secretGrants = options.secretGrants ?? [];
  for (const grant of secretGrants) assertRedactedSecretReference(grant);

  const refusalReasons: string[] = [];
  for (const runtime of options.runtimePreference) {
    const runtimeReadiness = options.readiness.runtimes.find((candidate) => candidate.runtime === runtime);
    if (!runtimeReadiness) {
      refusalReasons.push(`${runtime}: no readiness evidence is available.`);
      continue;
    }
    if (runtimeReadiness.status !== 'managed') {
      refusalReasons.push(`${runtimeReadiness.displayName}: ${runtimeReadiness.reason}`);
      continue;
    }
    const executionRestrictions = runtimeReadiness.capabilities
      .find((capability) => capability.capability === 'execution-restrictions');
    if (!executionRestrictions?.supported) {
      refusalReasons.push(
        `${runtimeReadiness.displayName}: cannot enforce the managed capability envelope `
        + '(execution restrictions unsupported).',
      );
      continue;
    }
    const envelope: CapabilityEnvelope = {
      runtime,
      profile: {
        writableWorktree: options.worktreePath,
        readableRoots: [options.worktreePath],
        allowedNetworkDomains: TRUSTED_RUNTIME_PROVIDER_DOMAINS[runtime],
        environmentAllowlist: MANAGED_ENVIRONMENT_ALLOWLIST,
        processCeiling: DEFAULT_PROCESS_CEILING,
        childRunCeiling: CHILD_RUN_CEILING,
      },
      secretGrants,
    };
    return { state: 'ready', capabilityEnvelope: envelope };
  }

  return {
    state: 'refused',
    reason: refusalReasons.length > 0
      ? `No preferred runtime can satisfy the managed capability envelope. ${refusalReasons.join(' ')}`
      : 'No runtime preference was provided.',
  };
}

// Resolves symlinks (and, for a path that does not exist yet, the real path
// of its nearest existing ancestor) so a symlink planted inside a granted
// root cannot be used to point enforcement at a location outside it.
function realOrResolvedPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const resolved = path.resolve(target);
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(realOrResolvedPath(parent), path.basename(resolved));
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = realOrResolvedPath(root);
  const resolvedTarget = realOrResolvedPath(target);
  if (resolvedTarget === resolvedRoot) return true;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertWritablePath(profile: EnvelopeProfile, targetPath: string): void {
  if (!isWithinRoot(profile.writableWorktree, targetPath)) {
    throw new CapabilityEnvelopeViolation(`Write denied outside the writable worktree: ${targetPath}`);
  }
}

export function assertReadablePath(profile: EnvelopeProfile, targetPath: string): void {
  const roots = [profile.writableWorktree, ...profile.readableRoots];
  if (!roots.some((root) => isWithinRoot(root, targetPath))) {
    throw new CapabilityEnvelopeViolation(`Read denied outside granted roots: ${targetPath}`);
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

export function assertNetworkDomainAllowed(profile: EnvelopeProfile, domain: string): void {
  const normalized = normalizeDomain(domain);
  const allowed = profile.allowedNetworkDomains.some((allowedDomain) => {
    const normalizedAllowed = normalizeDomain(allowedDomain);
    return normalized === normalizedAllowed || normalized.endsWith(`.${normalizedAllowed}`);
  });
  if (!allowed) {
    throw new CapabilityEnvelopeViolation(`Network access denied to ungranted domain: ${domain}`);
  }
}

export function assertProcessCeiling(profile: EnvelopeProfile, currentProcessCount: number): void {
  if (currentProcessCount >= profile.processCeiling) {
    throw new CapabilityEnvelopeViolation(
      `Process ceiling exceeded: at most ${profile.processCeiling} concurrent process(es) are allowed.`,
    );
  }
}

export function assertChildRunCeiling(profile: EnvelopeProfile, currentChildRunCount: number): void {
  if (currentChildRunCount >= profile.childRunCeiling) {
    throw new CapabilityEnvelopeViolation(
      `Child-Run ceiling exceeded: at most ${profile.childRunCeiling} child Run(s) are allowed.`,
    );
  }
}

export function assertSecretGrantAccess(envelope: CapabilityEnvelope, secretName: string): SecretGrant {
  const grant = envelope.secretGrants.find((candidate) => candidate.name === secretName);
  if (!grant) throw new CapabilityEnvelopeViolation(`Secret access denied to ungranted secret: ${secretName}`);
  return grant;
}

/** Only variables named in the Profile's allowlist survive; every other host shell variable is dropped. */
export function filterEnvironment(
  profile: EnvelopeProfile,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const name of profile.environmentAllowlist) {
    const value = sourceEnv[name];
    if (value !== undefined) filtered[name] = value;
  }
  return filtered;
}
