// The personal-resource access gate (issue #77; decision record
// docs/decisions/0003-personal-task-confinement.md). Agent-driven access to
// the owner's files and accounts is allowed only when a recorded live probe
// proved confinement for this runtime on this macOS major version.
// Everything else gets the deterministic workflow: AgentDeck itself performs
// fixed, owner-approved steps and no agent process touches personal
// resources. Developer Sessions and Runs never consult this gate; they keep
// their explicit power-user behavior.
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import type { AgentType } from '../types.js';
import type { ConfinedCredential } from './confined-launch.js';
import { assembleReport, type ConfinementProbeReport } from './probe.js';

export type PersonalResourceAccess =
  | {
    readonly mode: 'agent-confined';
    readonly runtime: AgentType;
    readonly mechanism: 'macos-seatbelt';
    readonly credential: ConfinedCredential;
    readonly agentTools: 'none' | 'shell';
  }
  | { readonly mode: 'deterministic-only'; readonly reason: string };

export interface PersonalResourceAccessInput {
  readonly platform: NodeJS.Platform;
  readonly macosVersion: string;
  readonly arch: string;
  readonly runtime: AgentType;
  /** The installed CLI's `--version` now; evidence from another version is stale. */
  readonly cliVersion: string;
  readonly evidence?: ConfinementProbeReport;
}

// Evidence without these was produced by shell probes alone and proves
// nothing about provider traffic or the broker path.
const REQUIRED_LIVE_CHECKS = ['live-provider-turn', 'live-provider-egress', 'live-broker-operation', 'live-no-leak'];

function major(version: string): string {
  return version.split('.')[0] ?? version;
}

function deterministic(reason: string): PersonalResourceAccess {
  return { mode: 'deterministic-only', reason };
}

export function decidePersonalResourceAccess(input: PersonalResourceAccessInput): PersonalResourceAccess {
  const { evidence } = input;
  if (input.platform !== 'darwin') return deterministic('Agent confinement is only proven on macOS.');
  if (!evidence) return deterministic(`Confinement has not been proven for ${input.runtime} on this Mac.`);
  if (evidence.runtime !== input.runtime) {
    return deterministic(`The recorded confinement evidence is for ${evidence.runtime}, not ${input.runtime}.`);
  }
  if (evidence.mechanism !== 'macos-seatbelt') {
    return deterministic(`The recorded confinement evidence uses an unsupported mechanism: ${evidence.mechanism}.`);
  }
  if (major(evidence.macosVersion) !== major(input.macosVersion)) {
    return deterministic(
      `Confinement was proven on macOS ${evidence.macosVersion}; re-run the probe on macOS ${input.macosVersion}.`,
    );
  }
  if (evidence.arch !== input.arch) {
    return deterministic(`Confinement was proven on ${evidence.arch}, not ${input.arch}; re-run the probe on this Mac.`);
  }
  if (evidence.cliVersion !== input.cliVersion) {
    return deterministic(
      `Confinement was proven with ${input.runtime} ${evidence.cliVersion}; re-run the probe for ${input.cliVersion}.`,
    );
  }
  const missingLive = REQUIRED_LIVE_CHECKS.filter((id) => !evidence.checks.some((check) => check.id === id));
  if (missingLive.length > 0) {
    return deterministic(`The confinement probe did not run live against the provider (missing ${missingLive.join(', ')}).`);
  }
  // Re-derive the verdict from the checks rather than trusting a stored flag.
  const settled = assembleReport(evidence, evidence.checks.map((check) => (
    check.outcome === 'accepted-risk' ? { ...check, outcome: 'fail' as const } : check
  )));
  if (!settled.passed) {
    const failed = settled.checks.filter((check) => check.outcome === 'fail').map((check) => check.id);
    return deterministic(`The confinement probe failed: ${failed.join(', ')}.`);
  }
  return {
    mode: 'agent-confined',
    runtime: evidence.runtime,
    mechanism: evidence.mechanism,
    credential: settled.credential,
    agentTools: settled.agentTools,
  };
}

function evidencePath(runtime: AgentType, dataDir: string): string {
  return path.join(dataDir, 'confinement', `${runtime}.json`);
}

export function recordConfinementEvidence(report: ConfinementProbeReport, dataDir = defaultDataDir()): string {
  const target = evidencePath(report.runtime, dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export function loadConfinementEvidence(runtime: AgentType, dataDir = defaultDataDir()): ConfinementProbeReport | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(evidencePath(runtime, dataDir), 'utf8')) as ConfinementProbeReport;
    return parsed.runtime === runtime && Array.isArray(parsed.checks) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
