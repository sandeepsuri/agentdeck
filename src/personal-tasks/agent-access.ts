// Agent help for personal tasks turns itself on. Decision 0003 lets an agent
// touch the owner's files or mail only when this Mac holds a passing live
// confinement probe for the Claude Code installed now. Rather than asking
// the owner to run scripts/probe-confinement.ts, AgentDeck runs that probe
// itself when the gate is off: the first time a personal task needs an
// agent, after Claude Code's sign-in is confirmed, and after a Claude Code or
// macOS update makes the recorded evidence stale.
//
// Only a passing report is recorded, so a probe that failed because Claude
// was signed out or offline never blocks a later attempt. An automatic probe
// runs at most once per launch (and again after Claude's sign-in is next
// confirmed); "Check sandbox again" in Settings › Providers always runs one.
import { recordConfinementEvidence } from '../confinement/decision.js';
import { runConfinementProbe, type ConfinementProbeReport } from '../confinement/probe.js';
import { resolveAgentExecutable } from '../sessions/executable.js';
import type { FilingProvider, FilingProviderAccess } from './confined-provider.js';

export type AgentAccessState = 'on' | 'checking' | 'off';

export interface AgentAccessView {
  state: AgentAccessState;
  /** Why agent help is off, in words for the owner. */
  reason?: string;
  checkedAt?: string;
}

export interface ConfinementProver {
  /** Whether a probe can run at all: macOS with Claude Code installed. */
  available(): boolean;
  /** Runs the live probe and records the report only if it passed. */
  prove(): Promise<ConfinementProbeReport>;
}

export function claudeConfinementProver(options: { dataDir: string; platform?: NodeJS.Platform }): ConfinementProver {
  const platform = options.platform ?? process.platform;
  return {
    available: () => platform === 'darwin' && Boolean(resolveAgentExecutable('claude')),
    async prove() {
      const executable = resolveAgentExecutable('claude');
      if (!executable) throw new Error('Claude Code is not installed on this Mac.');
      const report = await runConfinementProbe({ runtime: 'claude', executable, credential: 'macos-keychain', live: true });
      if (report.passed) recordConfinementEvidence(report, options.dataDir);
      return report;
    },
  };
}

function failedChecks(report: ConfinementProbeReport): string {
  return report.checks.filter((check) => check.outcome === 'fail').map((check) => check.id).join(', ');
}

export class AgentAccess {
  /** Undefined until the gate has been read once. */
  private current?: AgentAccessView;
  private running?: Promise<void>;
  /** Set once an automatic probe has run, so a failing Mac is not probed on every task. */
  private autoProbed = false;
  /** Why the last probe did not pass; it explains more than the gate's missing-evidence reason. */
  private probeFailure?: string;
  private stopped = false;

  constructor(private readonly options: {
    provider: FilingProvider;
    prover: ConfinementProver;
    now?: () => Date;
  }) {}

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  view(): AgentAccessView {
    return this.running || !this.current ? { ...this.current, state: 'checking' } : this.current;
  }

  /** The confined provider, with confinement proven first when it can be. */
  get provider(): FilingProvider {
    return {
      resolveAccess: async () => {
        await this.ensure();
        return this.resolve();
      },
      runTurn: (request) => this.options.provider.runTurn(request),
    };
  }

  /** Re-reads the gate and proves confinement if it is off and no automatic probe has run yet. */
  async refresh(options: { afterSignIn?: boolean } = {}): Promise<void> {
    if (options.afterSignIn) this.autoProbed = false;
    await this.ensure();
  }

  /** "Check sandbox again": always runs the probe, even after one failed. */
  checkAgain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.options.prover.available()) {
      this.current = { state: 'off', reason: 'Claude Code is not installed on this Mac.', checkedAt: this.now() };
      return Promise.resolve();
    }
    return this.prove();
  }

  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  shutdown(): void { this.stopped = true; }

  private async resolve(): Promise<FilingProviderAccess> {
    let access = await this.options.provider.resolveAccess();
    if (access.mode === 'deterministic-only' && this.probeFailure) access = { mode: 'deterministic-only', reason: this.probeFailure };
    this.current = access.mode === 'agent-confined'
      ? { state: 'on', checkedAt: this.now() }
      : { state: 'off', reason: access.reason, checkedAt: this.now() };
    return access;
  }

  private async ensure(): Promise<void> {
    if (this.running) return this.running;
    const access = await this.resolve();
    if (this.running) return this.running;
    if (access.mode === 'agent-confined' || this.stopped || this.autoProbed || !this.options.prover.available()) return;
    return this.prove();
  }

  private prove(): Promise<void> {
    this.autoProbed = true;
    const running = (async () => {
      try {
        const report = await this.options.prover.prove();
        this.probeFailure = report.passed
          ? undefined
          : `AgentDeck could not confirm that Claude Code stays sandboxed on this Mac (failed: ${failedChecks(report)}). Make sure Claude Code is signed in and this Mac is online, then choose Check sandbox again in Settings › Providers.`;
      } catch (error) {
        this.probeFailure = `The sandbox check could not finish: ${error instanceof Error ? error.message : String(error)}. Choose Check sandbox again in Settings › Providers.`;
      }
      try {
        await this.resolve();
      } catch {
        this.current = { state: 'off', reason: this.probeFailure ?? 'Claude Code could not be checked.', checkedAt: this.now() };
      } finally {
        this.running = undefined;
      }
    })();
    this.running = running;
    return running;
  }
}
