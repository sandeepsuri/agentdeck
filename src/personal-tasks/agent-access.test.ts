// Agent help for personal tasks turns itself on: AgentDeck runs the
// confinement probe while the gate is off, instead of the owner running
// scripts/probe-confinement.ts. The provider and prover are fakes; no CLI runs.
import { describe, expect, it } from 'vitest';
import type { ConfinementProbeReport } from '../confinement/probe.js';
import { AgentAccess, type ConfinementProver } from './agent-access.js';
import type { FilingProvider, FilingProviderAccess } from './confined-provider.js';

const CONFINED: FilingProviderAccess = { mode: 'agent-confined', runtime: 'claude', executable: '/bin/claude', cliVersion: '2.1.283', credential: 'macos-keychain' };
const UNPROVEN: FilingProviderAccess = { mode: 'deterministic-only', reason: 'Confinement has not been proven for claude on this Mac.' };

function report(passed: boolean): ConfinementProbeReport {
  return {
    mechanism: 'macos-seatbelt', macosVersion: '26.2', arch: 'arm64', runtime: 'claude', cliVersion: '2.1.283',
    credential: 'macos-keychain', agentTools: 'none', passed,
    checks: passed ? [] : [{ id: 'live-provider-turn', description: '', expect: 'allow', outcome: 'fail', evidence: 'signed out' }],
  } as ConfinementProbeReport;
}

function fixture(options: { passes?: boolean[]; available?: boolean; throws?: boolean } = {}) {
  let proven = false;
  const passes = [...(options.passes ?? [true])];
  let probes = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const provider: FilingProvider = {
    resolveAccess: async () => (proven ? CONFINED : UNPROVEN),
    runTurn: async () => { throw new Error('not used'); },
  };
  const prover: ConfinementProver = {
    available: () => options.available ?? true,
    async prove() {
      probes += 1;
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      if (options.throws) throw new Error('sandbox-exec is missing');
      const passed = passes.shift() ?? false;
      if (passed) proven = true;
      return report(passed);
    },
  };
  const access = new AgentAccess({ provider, prover, now: () => new Date('2026-09-28T12:00:00.000Z') });
  return {
    access,
    probes: () => probes,
    holdNextProbe: () => { hold = true; },
    releaseProbe: () => { hold = false; release?.(); },
    forgetEvidence: () => { proven = false; },
  };
}

describe('AgentAccess', () => {
  it('proves confinement the first time a personal task needs an agent, then uses the agent', async () => {
    const { access, probes } = fixture();
    expect(await access.provider.resolveAccess()).toEqual(CONFINED);
    expect(probes()).toBe(1);
    expect(access.view()).toEqual({ state: 'on', checkedAt: '2026-09-28T12:00:00.000Z' });
    await access.provider.resolveAccess();
    expect(probes()).toBe(1);
  });

  it('shows checking while the probe runs, and a task waits for it instead of failing', async () => {
    const { access, holdNextProbe, releaseProbe } = fixture();
    holdNextProbe();
    const refreshing = access.refresh();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(access.view().state).toBe('checking');
    const task = access.provider.resolveAccess();
    releaseProbe();
    await refreshing;
    expect(await task).toEqual(CONFINED);
  });

  it('probes a failing Mac once per launch, explains why in plain words, and probes again after sign-in', async () => {
    const { access, probes } = fixture({ passes: [false, true] });
    const first = await access.provider.resolveAccess();
    expect(first.mode).toBe('deterministic-only');
    expect(first.mode === 'deterministic-only' && first.reason).toMatch(/could not confirm that Claude Code stays sandboxed.*live-provider-turn.*signed in/);
    expect(access.view()).toMatchObject({ state: 'off', reason: expect.stringMatching(/Check sandbox again/) });
    await access.provider.resolveAccess();
    expect(probes()).toBe(1);

    await access.refresh({ afterSignIn: true });
    expect(probes()).toBe(2);
    expect(access.view().state).toBe('on');
  });

  it('proves again when a Claude Code update makes the evidence stale', async () => {
    const { access, probes, forgetEvidence } = fixture({ passes: [true, true] });
    await access.refresh();
    forgetEvidence();
    await access.refresh({ afterSignIn: true });
    expect(probes()).toBe(2);
    expect(access.view().state).toBe('on');
  });

  it('Check sandbox again always runs the probe', async () => {
    const { access, probes } = fixture({ passes: [false, true] });
    await access.refresh();
    await access.checkAgain();
    expect(probes()).toBe(2);
    expect(access.view().state).toBe('on');
  });

  it('reports a probe that could not finish', async () => {
    const { access } = fixture({ throws: true });
    await access.refresh();
    expect(access.view()).toMatchObject({ state: 'off', reason: expect.stringMatching(/could not finish: sandbox-exec is missing/) });
  });

  it('never probes without Claude Code installed, and keeps the gate reason', async () => {
    const { access, probes } = fixture({ available: false });
    expect(await access.provider.resolveAccess()).toEqual(UNPROVEN);
    await access.checkAgain();
    expect(probes()).toBe(0);
    expect(access.view()).toMatchObject({ state: 'off', reason: 'Claude Code is not installed on this Mac.' });
  });

  it('does not start a probe after shutdown', async () => {
    const { access, probes } = fixture();
    access.shutdown();
    await access.refresh();
    expect(probes()).toBe(0);
  });
});
