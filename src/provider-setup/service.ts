// Issue #85: setting up a provider CLI from the Mac app — find it, install it
// through the provider's supported path, sign in through the provider's own
// browser flow, and confirm readiness with a harmless check.
//
// AgentDeck never handles a credential. Sign-in runs the provider's own
// `claude auth login` / `codex login`, which opens the provider's page in the
// browser and stores the result in the provider's own storage. The only thing
// that can pass through here is the one-time code Claude's fallback page shows,
// written straight to the CLI's stdin and never kept. What is persisted is the
// readiness metadata in readiness.ts; operations live in memory and end with
// the service.
import {
  assessClaudeReadiness,
  assessCodexReadiness,
  PROVIDER_NAMES,
  repairFor,
  SETUP_PROVIDERS,
  type CodexRateLimitsRead,
  type CommandEvidence,
  type ProviderReadinessAssessment,
  type ReadinessAllowanceWindow,
  type RepairGuide,
  type SetupProvider,
} from './readiness.js';
import type { AgentAccess, AgentAccessView } from '../personal-tasks/agent-access.js';
import type { ProviderReadinessRepository, StoredProviderReadiness } from '../store/provider-readiness.js';

/** A long-running provider process (installer or sign-in). */
export interface LongProcess {
  onOutput(listener: (text: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  write(text: string): void;
  kill(): void;
}

/** How the service reaches the provider CLIs; commands.ts runs them for real. */
export interface ProviderCommands {
  /** Absolute path of the installed CLI, or undefined. */
  locate(provider: SetupProvider): string | undefined;
  /** Runs a short command to completion; never rejects. */
  run(executable: string, args: readonly string[], options: { timeoutMs: number }): Promise<CommandEvidence>;
  /** `account/rateLimits/read` through `codex app-server`; spends no allowance. */
  readCodexRateLimits(executable: string): Promise<CodexRateLimitsRead>;
  start(command: string, args: readonly string[], options: { stdin: boolean }): LongProcess;
  /** Opens an https address in the owner's default browser. */
  openUrl(url: string): Promise<void>;
  /** Stops every process still running, including readiness checks. */
  stopAll?(): void;
}

export type SetupOperationKind = 'check' | 'install' | 'sign-in';

export interface SetupOperationView {
  kind: SetupOperationKind;
  state: 'running' | 'failed';
  startedAt: string;
  message?: string;
  /** The CLI printed its sign-in page address, so it can be opened again. */
  browserPageAvailable?: boolean;
  /** Claude's fallback page shows a code to paste back. */
  acceptsCode?: boolean;
}

export interface ProviderReadinessView extends StoredProviderReadiness {
  /** From the latest check this launch only; never persisted. */
  allowance?: ReadinessAllowanceWindow[];
}

export interface ProviderSetupEntry {
  provider: SetupProvider;
  name: string;
  /** Whether the readiness shown was checked since AgentDeck last started. */
  confirmedThisLaunch: boolean;
  readiness?: ProviderReadinessView;
  operation?: SetupOperationView;
  repair?: RepairGuide;
  /** Claude only: whether an agent may help with personal tasks on this Mac. */
  agentAccess?: AgentAccessView;
}

export interface ProviderSetupView { providers: ProviderSetupEntry[] }

export class ProviderSetupError extends Error {
  constructor(readonly code: 'invalid-state' | 'invalid-input' | 'not-installed' | 'unsupported', message: string) {
    super(message);
  }
}

export const CLAUDE_INSTALLER_URL = 'https://claude.ai/install.sh';
export const INSTALL_GUIDES: Record<SetupProvider, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
};

const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--tools', ''];
const SIGN_IN_ARGS: Record<SetupProvider, string[]> = { claude: ['auth', 'login', '--claudeai'], codex: ['login'] };
/** Only these hosts' pages are ever opened from printed CLI output. */
const SIGN_IN_HOSTS = new Set(['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com', 'auth.openai.com']);
const SIGN_IN_CODE = /^[A-Za-z0-9#._~-]{8,1024}$/;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;

interface Operation {
  kind: SetupOperationKind;
  state: 'running' | 'failed';
  startedAt: string;
  message?: string;
  process?: LongProcess;
  timer?: ReturnType<typeof setTimeout>;
  output: string;
  signInUrl?: string;
  acceptsCode?: boolean;
}

function signInUrlFrom(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'https:' && SIGN_IN_HOSTS.has(url.hostname)) return url.toString();
    } catch { /* not a URL */ }
  }
  return undefined;
}

function lastLines(output: string, home: string | undefined): string {
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((line) => line.trim()).filter(Boolean).slice(-3);
  const text = lines.join(' ');
  return home ? text.split(home).join('~') : text;
}

export interface ProviderSetupServiceOptions {
  repository: ProviderReadinessRepository;
  commands: ProviderCommands;
  now?: () => Date;
  home?: string;
  /** Proves Claude Code's confinement once it is ready, so personal tasks can use an agent. */
  agentAccess?: AgentAccess;
}

export class ProviderSetupService {
  private readonly operations = new Map<SetupProvider, Operation>();
  private readonly allowance = new Map<SetupProvider, ReadinessAllowanceWindow[] | undefined>();
  private readonly confirmed = new Set<SetupProvider>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private readonly options: ProviderSetupServiceOptions) {}

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  view(): ProviderSetupView {
    return {
      providers: SETUP_PROVIDERS.map((provider) => {
        const stored = this.options.repository.get(provider);
        const operation = this.operations.get(provider);
        const allowance = this.confirmed.has(provider) ? this.allowance.get(provider) : undefined;
        return {
          provider,
          name: PROVIDER_NAMES[provider],
          confirmedThisLaunch: this.confirmed.has(provider),
          ...(stored ? { readiness: { ...stored, ...(allowance ? { allowance } : {}) }, repair: repairFor(provider, stored.state) } : {}),
          ...(provider === 'claude' && this.options.agentAccess ? { agentAccess: this.options.agentAccess.view() } : {}),
          ...(operation ? {
            operation: {
              kind: operation.kind,
              state: operation.state,
              startedAt: operation.startedAt,
              ...(operation.message ? { message: operation.message } : {}),
              ...(operation.kind === 'sign-in' ? { browserPageAvailable: Boolean(operation.signInUrl), acceptsCode: Boolean(operation.acceptsCode) } : {}),
            },
          } : {}),
        };
      }),
    };
  }

  /** Checks, once per launch, every provider not yet checked, so a sign-out or account change made elsewhere is noticed. */
  ensureCheckedThisLaunch(): void {
    for (const provider of SETUP_PROVIDERS) {
      if (!this.confirmed.has(provider) && !this.operations.has(provider)) void this.check(provider).catch(() => undefined);
    }
  }

  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  private assertIdle(provider: SetupProvider): void {
    if (this.stopped) throw new ProviderSetupError('invalid-state', 'AgentDeck is shutting down.');
    if (this.operations.get(provider)?.state === 'running') {
      throw new ProviderSetupError('invalid-state', `${PROVIDER_NAMES[provider]} setup is already doing something. Wait for it or cancel it.`);
    }
  }

  private begin(provider: SetupProvider, kind: SetupOperationKind): Operation {
    this.assertIdle(provider);
    const operation: Operation = { kind, state: 'running', startedAt: this.now(), output: '' };
    this.operations.set(provider, operation);
    return operation;
  }

  private fail(provider: SetupProvider, operation: Operation, message: string): void {
    if (this.operations.get(provider) !== operation) return;
    clearTimeout(operation.timer);
    delete operation.process;
    operation.state = 'failed';
    operation.message = message;
  }

  private executable(provider: SetupProvider): string {
    const executable = this.options.commands.locate(provider);
    if (!executable) throw new ProviderSetupError('not-installed', `${PROVIDER_NAMES[provider]} is not installed on this Mac.`);
    return executable;
  }

  check(provider: SetupProvider): Promise<ProviderReadinessView> {
    const operation = this.begin(provider, 'check');
    return this.track(this.runCheck(provider, operation));
  }

  private async runCheck(provider: SetupProvider, operation: Operation): Promise<ProviderReadinessView> {
    let assessment: ProviderReadinessAssessment;
    try {
      assessment = await this.assess(provider);
    } catch (error) {
      assessment = { state: 'check-failed', detail: `The readiness check could not run: ${error instanceof Error ? error.message : String(error)}` };
    }
    const checkedAt = this.now();
    const previous = this.options.repository.get(provider);
    const lastReadyAt = assessment.state === 'ready' ? checkedAt : previous?.lastReadyAt;
    const record: StoredProviderReadiness = {
      provider,
      state: assessment.state,
      detail: assessment.detail,
      ...(assessment.cliVersion ? { cliVersion: assessment.cliVersion } : {}),
      ...(assessment.authMethod ? { authMethod: assessment.authMethod } : {}),
      ...(assessment.plan ? { plan: assessment.plan } : {}),
      checkedAt,
      ...(lastReadyAt ? { lastReadyAt } : {}),
    };
    // A check still running at shutdown must not write to a closing store.
    if (this.stopped) return record;
    this.options.repository.put(record);
    this.allowance.set(provider, assessment.allowance);
    const newlyReady = assessment.state === 'ready' && (previous?.state !== 'ready' || !this.confirmed.has(provider));
    this.confirmed.add(provider);
    // Claude is signed in: prove its confinement now rather than when a personal task first needs it.
    if (provider === 'claude' && newlyReady && this.options.agentAccess) {
      void this.track(this.options.agentAccess.refresh({ afterSignIn: true })).catch(() => undefined);
    }
    if (this.operations.get(provider) === operation) this.operations.delete(provider);
    return { ...record, ...(assessment.allowance ? { allowance: assessment.allowance } : {}) };
  }

  private async assess(provider: SetupProvider): Promise<ProviderReadinessAssessment> {
    const { commands } = this.options;
    const executable = commands.locate(provider);
    if (provider === 'claude') {
      if (!executable) return assessClaudeReadiness({ installed: false });
      const version = await commands.run(executable, ['--version'], { timeoutMs: 10_000 });
      const authStatus = await commands.run(executable, ['auth', 'status'], { timeoutMs: 10_000 });
      const signedIn = /"loggedIn"\s*:\s*true/.test(authStatus.stdout);
      const usage = signedIn ? await commands.run(executable, CLAUDE_USAGE_ARGS, { timeoutMs: 30_000 }) : undefined;
      return assessClaudeReadiness({ installed: true, version: version.stdout, authStatus, ...(usage ? { usage } : {}) });
    }
    if (!executable) return assessCodexReadiness({ installed: false });
    const version = await commands.run(executable, ['--version'], { timeoutMs: 10_000 });
    const loginStatus = await commands.run(executable, ['login', 'status'], { timeoutMs: 10_000 });
    const rateLimits = loginStatus.exitCode === 0 ? await commands.readCodexRateLimits(executable) : undefined;
    return assessCodexReadiness({ installed: true, version: version.stdout, loginStatus, ...(rateLimits ? { rateLimits } : {}) });
  }

  /** Runs a provider process to its end, then a readiness check if it succeeded. */
  private supervise(provider: SetupProvider, operation: Operation, process: LongProcess, timeoutMs: number, onFailure: (code: number | null) => string): void {
    operation.process = process;
    process.onOutput((text) => {
      operation.output = (operation.output + text).slice(-OUTPUT_LIMIT);
      if (operation.kind === 'sign-in') {
        operation.signInUrl ??= signInUrlFrom(operation.output);
        if (provider === 'claude' && /paste code/i.test(operation.output)) operation.acceptsCode = true;
      }
    });
    operation.timer = setTimeout(() => {
      process.kill();
      this.fail(provider, operation, `${operation.kind === 'install' ? 'Installation' : 'Sign-in'} took too long and was stopped. Try again.`);
    }, timeoutMs);
    operation.timer.unref?.();
    this.track(new Promise<void>((resolve) => {
      process.onExit((code) => {
        clearTimeout(operation.timer);
        if (this.operations.get(provider) !== operation || operation.state !== 'running') { resolve(); return; }
        delete operation.process;
        if (code !== 0) {
          this.fail(provider, operation, onFailure(code));
          resolve();
          return;
        }
        this.operations.delete(provider);
        this.check(provider).then(() => resolve(), () => resolve());
      });
    }));
  }

  install(provider: SetupProvider): void {
    if (provider !== 'claude') {
      throw new ProviderSetupError('unsupported', `${PROVIDER_NAMES[provider]} is installed from its own install page. Open the install page instead.`);
    }
    const operation = this.begin(provider, 'install');
    // Anthropic's documented native installer, unchanged. It installs into
    // the owner's home folder and needs no administrator rights.
    // pipefail: a failed download must fail the install, not feed bash nothing.
    const child = this.options.commands.start('/bin/bash', ['-o', 'pipefail', '-c', `curl -fsSL ${CLAUDE_INSTALLER_URL} | bash`], { stdin: false });
    this.supervise(provider, operation, child, INSTALL_TIMEOUT_MS, () => {
      const detail = lastLines(operation.output, this.options.home);
      return `The Claude Code installer did not finish.${detail ? ` It said: ${detail}` : ''} Check that this Mac is online, then try again.`;
    });
  }

  /** Runs the confinement probe again, for example after one failed. */
  checkAgentAccess(provider: SetupProvider): void {
    if (provider !== 'claude' || !this.options.agentAccess) {
      throw new ProviderSetupError('unsupported', `Personal tasks use Claude Code, not ${PROVIDER_NAMES[provider]}.`);
    }
    if (this.stopped) throw new ProviderSetupError('invalid-state', 'AgentDeck is shutting down.');
    void this.track(this.options.agentAccess.checkAgain()).catch(() => undefined);
  }

  async openInstallGuide(provider: SetupProvider): Promise<void> {
    await this.options.commands.openUrl(INSTALL_GUIDES[provider]);
  }

  signIn(provider: SetupProvider): void {
    this.assertIdle(provider);
    const executable = this.executable(provider);
    const operation = this.begin(provider, 'sign-in');
    const child = this.options.commands.start(executable, SIGN_IN_ARGS[provider], { stdin: true });
    this.supervise(provider, operation, child, SIGN_IN_TIMEOUT_MS, () => 'Sign-in did not finish. Choose Sign in to try again.');
  }

  private runningSignIn(provider: SetupProvider): Operation {
    const operation = this.operations.get(provider);
    if (operation?.kind !== 'sign-in' || operation.state !== 'running' || !operation.process) {
      throw new ProviderSetupError('invalid-state', `No ${PROVIDER_NAMES[provider]} sign-in is waiting.`);
    }
    return operation;
  }

  async openSignInPage(provider: SetupProvider): Promise<void> {
    const operation = this.runningSignIn(provider);
    if (!operation.signInUrl) throw new ProviderSetupError('invalid-state', 'The sign-in page address is not available yet.');
    await this.options.commands.openUrl(operation.signInUrl);
  }

  submitSignInCode(provider: SetupProvider, code: string): void {
    const operation = this.runningSignIn(provider);
    const trimmed = code.trim();
    if (!operation.acceptsCode) throw new ProviderSetupError('invalid-state', `${PROVIDER_NAMES[provider]} is not asking for a code.`);
    if (!SIGN_IN_CODE.test(trimmed)) throw new ProviderSetupError('invalid-input', 'That does not look like the sign-in code from the browser page.');
    operation.process!.write(`${trimmed}\n`);
  }

  cancel(provider: SetupProvider): void {
    const operation = this.operations.get(provider);
    if (!operation) return;
    if (operation.kind === 'check' && operation.state === 'running') {
      throw new ProviderSetupError('invalid-state', 'A readiness check finishes on its own in a few seconds.');
    }
    this.operations.delete(provider);
    clearTimeout(operation.timer);
    operation.process?.kill();
  }

  /** Stops installers, sign-ins, and checks still running so none outlives AgentDeck. */
  shutdown(): void {
    this.stopped = true;
    this.options.agentAccess?.shutdown();
    for (const [provider, operation] of this.operations) {
      clearTimeout(operation.timer);
      if (operation.process) {
        this.operations.delete(provider);
        operation.process.kill();
      }
    }
    this.options.commands.stopAll?.();
  }
}
