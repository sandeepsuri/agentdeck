// Issue #85: stand-in provider CLIs for ProviderSetupService tests. Nothing
// here runs a real provider; outputs follow the observed shapes with invented
// identities.
import type { CommandEvidence } from '../provider-setup/readiness.js';
import type { LongProcess, ProviderCommands } from '../provider-setup/service.js';

export const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgId: 'org-1', subscriptionType: 'max' });
export const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
export const USAGE = JSON.stringify({ type: 'result', is_error: false, result: 'Current session: 12% used · resets 9pm\nCurrent week (all models): 30% used · resets Monday' });

export class FakeProcess implements LongProcess {
  written: string[] = [];
  killed = false;
  private outputListeners: ((text: string) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  constructor(readonly command: string, readonly args: readonly string[]) {}
  onOutput(listener: (text: string) => void): void { this.outputListeners.push(listener); }
  onExit(listener: (code: number | null) => void): void { this.exitListeners.push(listener); }
  write(text: string): void { this.written.push(text); }
  kill(): void { this.killed = true; this.exit(null); }
  print(text: string): void { for (const listener of this.outputListeners) listener(text); }
  exit(code: number | null): void { for (const listener of this.exitListeners.splice(0)) listener(code); }
}

export class FakeCommands implements ProviderCommands {
  installed: Record<'claude' | 'codex', boolean> = { claude: true, codex: false };
  authStatus: CommandEvidence = { exitCode: 0, stdout: SIGNED_IN };
  usage: CommandEvidence = { exitCode: 0, stdout: USAGE };
  runs: string[][] = [];
  processes: FakeProcess[] = [];
  opened: string[] = [];

  locate(provider: 'claude' | 'codex'): string | undefined {
    return this.installed[provider] ? `/Users/owner/.local/bin/${provider}` : undefined;
  }

  async run(_executable: string, args: readonly string[]): Promise<CommandEvidence> {
    this.runs.push([...args]);
    if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.283 (Claude Code)' };
    if (args[0] === 'auth') return this.authStatus;
    if (args[0] === '-p') return this.usage;
    if (args[0] === 'login') return { exitCode: 1, stdout: 'Not logged in' };
    throw new Error(`unexpected command ${args.join(' ')}`);
  }

  async readCodexRateLimits(): Promise<{ error: string }> { return { error: 'codex account authentication required' }; }

  start(command: string, args: readonly string[]): LongProcess {
    const process = new FakeProcess(command, args);
    this.processes.push(process);
    return process;
  }

  async openUrl(url: string): Promise<void> { this.opened.push(url); }
}
