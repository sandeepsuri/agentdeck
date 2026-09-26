// Issue #81: the confined provider's access decision, and its launch under
// real Seatbelt with a stand-in CLI (no provider, credential, or personal
// file involved).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_EXEC } from '../confinement/confined-launch.js';
import { assembleReport, type ConfinementProbeReport, type ProbeCheck } from '../confinement/probe.js';
import { confinedClaudeProvider, type ConfinedClaudeProviderOptions, type ConfinedProviderAccess } from './confined-provider.js';
import { FILING_BROKER_MCP_TOOLS } from './filing-broker.js';

const VERSION = '2.1.283 (Claude Code)';

function check(id: string, outcome: ProbeCheck['outcome'] = 'pass'): ProbeCheck {
  return { id, description: id, expect: 'deny', outcome, evidence: '' };
}

function evidence(toolSurface: ProbeCheck['outcome'] = 'pass', credential: ConfinementProbeReport['credential'] = 'macos-keychain'): ConfinementProbeReport {
  return assembleReport({ mechanism: 'macos-seatbelt', macosVersion: '26.2', arch: process.arch, runtime: 'claude', cliVersion: VERSION, credential }, [
    check('ungranted-read'), check('keychain', credential === 'none' ? 'pass' : 'fail'),
    ...['live-provider-turn', 'live-provider-egress', 'live-broker-operation', 'live-no-leak'].map((id) => check(id)),
    check('live-tool-surface', toolSurface),
  ]);
}

function provider(overrides: Partial<ConfinedClaudeProviderOptions> = {}) {
  return confinedClaudeProvider({
    platform: 'darwin',
    findExecutable: () => '/opt/claude',
    readCliVersion: async () => VERSION,
    readMacosVersion: async () => '26.2',
    loadEvidence: () => evidence(),
    ...overrides,
  });
}

describe('confined provider access', () => {
  it('is confined only with passing live evidence for the installed CLI', async () => {
    expect(await provider().resolveAccess()).toEqual({
      mode: 'agent-confined', runtime: 'claude', executable: '/opt/claude', cliVersion: VERSION, credential: 'macos-keychain',
    });
  });

  it.each([
    ['another platform', { platform: 'linux' as const }, /only proven on macOS/],
    ['no CLI', { findExecutable: () => undefined }, /not installed/],
    ['no recorded evidence', { loadEvidence: () => undefined }, /has not been proven/],
    ['an updated CLI', { readCliVersion: async () => '2.1.290 (Claude Code)' }, /re-run the probe for 2\.1\.290/],
    ['another macOS major', { readMacosVersion: async () => '27.0' }, /re-run the probe on macOS 27/],
    ['a shell-capable agent', { loadEvidence: () => evidence('fail', 'none') }, /process-spawning tool/],
  ])('stays deterministic-only with %s, and says why', async (_label, overrides, reason) => {
    const access = await provider(overrides).resolveAccess();
    expect(access.mode).toBe('deterministic-only');
    expect(access.mode === 'deterministic-only' && access.reason).toMatch(reason);
  });
});

const canApplySeatbelt = process.platform === 'darwin'
  && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const install = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fake-claude-')));
afterAll(() => fs.rmSync(install, { recursive: true, force: true }));

/** A stand-in CLI that reports `tools` in its init event, then finishes after `delay` seconds. */
function standIn(name: string, tools: readonly string[], delay = 0): string {
  const executable = path.join(install, name, 'bin', 'claude');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const init = JSON.stringify({ type: 'system', subtype: 'init', tools });
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  fs.writeFileSync(executable, `#!/bin/sh\necho '${init}'\nsleep ${delay}\necho '${result}'\n`, { mode: 0o755 });
  return executable;
}

const access = (executable: string): ConfinedProviderAccess => ({
  mode: 'agent-confined', runtime: 'claude', executable, cliVersion: VERSION, credential: 'none',
});
const broker = { url: 'http://127.0.0.1:9/mcp', port: 9, token: 'token' };

describe.skipIf(!canApplySeatbelt)('confined provider turn (real Seatbelt, stand-in CLI)', () => {
  it('completes a turn that offers only broker tools', async () => {
    const executable = standIn('ok', FILING_BROKER_MCP_TOOLS);
    const turn = await confinedClaudeProvider({ timeoutMs: 20_000 }).runTurn({
      access: access(executable), prompt: 'p', broker, allowedTools: FILING_BROKER_MCP_TOOLS,
    });
    expect(turn).toEqual({ status: 'ok', reason: 'Completed.', toolsOffered: FILING_BROKER_MCP_TOOLS });
  }, 30_000);

  it('kills the CLI as soon as it offers anything beyond the broker', async () => {
    const executable = standIn('shell', [...FILING_BROKER_MCP_TOOLS, 'Bash'], 20);
    const started = Date.now();
    const turn = await confinedClaudeProvider({ timeoutMs: 25_000 }).runTurn({
      access: access(executable), prompt: 'p', broker, allowedTools: FILING_BROKER_MCP_TOOLS,
    });
    expect(turn.status).toBe('tool-surface');
    expect(turn.reason).toMatch(/Bash/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('owns the deadline when the CLI never finishes', async () => {
    const executable = standIn('slow', FILING_BROKER_MCP_TOOLS, 30);
    const turn = await confinedClaudeProvider({ timeoutMs: 1_000 }).runTurn({
      access: access(executable), prompt: 'p', broker, allowedTools: FILING_BROKER_MCP_TOOLS,
    });
    expect(turn).toMatchObject({ status: 'interrupted', reason: 'No result within 1 seconds.' });
  }, 30_000);
});
