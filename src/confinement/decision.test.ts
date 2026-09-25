import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decidePersonalResourceAccess, loadConfinementEvidence, recordConfinementEvidence } from './decision.js';
import { assembleReport, type ConfinementProbeReport, type ProbeCheck } from './probe.js';

function check(id: string, outcome: ProbeCheck['outcome'] = 'pass'): ProbeCheck {
  return { id, description: id, expect: 'deny', outcome, evidence: '' };
}

const shellChecks = ['ungranted-read', 'symlink-read-escape', 'inherited-environment', 'direct-network'].map((id) => check(id));
const liveChecks = ['live-provider-turn', 'live-provider-egress', 'live-broker-operation', 'live-no-leak'].map((id) => check(id));

function report(overrides: { checks?: ProbeCheck[]; credential?: ConfinementProbeReport['credential']; macosVersion?: string } = {}) {
  return assembleReport({
    mechanism: 'macos-seatbelt',
    macosVersion: overrides.macosVersion ?? '26.2',
    arch: 'arm64',
    runtime: 'claude',
    cliVersion: '2.1.283 (Claude Code)',
    credential: overrides.credential ?? 'macos-keychain',
  }, overrides.checks ?? [...shellChecks, check('keychain', 'fail'), check('provider-credential', 'fail'), ...liveChecks, check('live-tool-surface')]);
}

const mac = { platform: 'darwin' as const, macosVersion: '26.2', arch: 'arm64', runtime: 'claude' as const, cliVersion: '2.1.283 (Claude Code)' };

describe('assembleReport', () => {
  it('accepts the keychain exposure only when the agent was proven to have no process-spawning tool', () => {
    const toolless = report();
    expect(toolless.agentTools).toBe('none');
    expect(toolless.checks.find((candidate) => candidate.id === 'keychain')?.outcome).toBe('accepted-risk');
    expect(toolless.passed).toBe(true);

    const withShell = report({
      checks: [...shellChecks, check('keychain', 'fail'), check('provider-credential', 'fail'), ...liveChecks, check('live-tool-surface', 'fail')],
    });
    expect(withShell.agentTools).toBe('shell');
    expect(withShell.checks.find((candidate) => candidate.id === 'keychain')?.outcome).toBe('fail');
    expect(withShell.passed).toBe(false);
  });

  it('never accepts a filesystem, network or environment failure', () => {
    const leaked = report({ checks: [...shellChecks, check('symlink-write-escape', 'fail'), ...liveChecks, check('live-tool-surface')] });
    expect(leaked.passed).toBe(false);
  });
});

describe('decidePersonalResourceAccess', () => {
  it('allows agent-driven access only with passing live evidence for this runtime and macOS', () => {
    expect(decidePersonalResourceAccess({ ...mac, evidence: report() })).toEqual({
      mode: 'agent-confined', runtime: 'claude', mechanism: 'macos-seatbelt', credential: 'macos-keychain', agentTools: 'none',
    });
  });

  it('falls back to the deterministic workflow without evidence or off macOS', () => {
    expect(decidePersonalResourceAccess(mac).mode).toBe('deterministic-only');
    expect(decidePersonalResourceAccess({ ...mac, platform: 'linux', evidence: report() }).mode).toBe('deterministic-only');
  });

  it('falls back when the evidence is for another runtime or another macOS major version', () => {
    expect(decidePersonalResourceAccess({ ...mac, runtime: 'codex', evidence: report() }).mode).toBe('deterministic-only');
    const upgraded = decidePersonalResourceAccess({ ...mac, macosVersion: '27.0', evidence: report() });
    expect(upgraded).toMatchObject({ mode: 'deterministic-only' });
    expect(upgraded.mode === 'deterministic-only' && upgraded.reason).toMatch(/27/);
  });

  it('falls back on another architecture or after the CLI updates itself', () => {
    expect(decidePersonalResourceAccess({ ...mac, arch: 'x64', evidence: report() }).mode).toBe('deterministic-only');
    const updated = decidePersonalResourceAccess({ ...mac, cliVersion: '2.1.284 (Claude Code)', evidence: report() });
    expect(updated.mode === 'deterministic-only' && updated.reason).toMatch(/2\.1\.284/);
  });

  it('re-derives the verdict instead of trusting a stored passed flag', () => {
    const tampered = { ...report({ checks: [...shellChecks, check('ungranted-read', 'fail'), ...liveChecks, check('live-tool-surface')] }), passed: true };
    expect(decidePersonalResourceAccess({ ...mac, evidence: tampered }).mode).toBe('deterministic-only');
  });

  it('falls back and names the failing checks when the probe failed', () => {
    const failed = decidePersonalResourceAccess({
      ...mac, evidence: report({ checks: [...shellChecks, check('ungranted-read', 'fail'), ...liveChecks, check('live-tool-surface')] }),
    });
    expect(failed.mode === 'deterministic-only' && failed.reason).toContain('ungranted-read');
  });

  it('falls back when only shell probes ran, because provider traffic was never proven', () => {
    const shellOnly = decidePersonalResourceAccess({ ...mac, evidence: report({ checks: shellChecks, credential: 'none' }) });
    expect(shellOnly.mode === 'deterministic-only' && shellOnly.reason).toMatch(/live/);
  });
});

describe('confinement evidence storage', () => {
  let dataDir: string | undefined;
  afterEach(() => { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('round-trips a report per runtime and ignores missing or malformed files', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-evidence-'));
    expect(loadConfinementEvidence('claude', dataDir)).toBeUndefined();
    recordConfinementEvidence(report(), dataDir);
    expect(loadConfinementEvidence('claude', dataDir)).toEqual(report());
    expect(loadConfinementEvidence('codex', dataDir)).toBeUndefined();
    fs.writeFileSync(path.join(dataDir, 'confinement', 'codex.json'), '{not json');
    expect(loadConfinementEvidence('codex', dataDir)).toBeUndefined();
  });
});
