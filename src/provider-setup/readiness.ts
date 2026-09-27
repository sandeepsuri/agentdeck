// Issue #85: provider setup readiness. A readiness check asks the provider's
// own CLI three harmless questions — its version, whether it is signed in, and
// how much of the plan's allowance is used — and spends no allowance doing it
// (`claude -p /usage` answers with 0 turns; Codex's `account/rateLimits/read`
// runs no turn). This module only interprets what the CLI printed; running it
// lives in service.ts. It has no Node imports so the UI can share the types
// and repair steps.
//
// Only readiness metadata leaves this module: state, CLI version, sign-in
// method, plan name, and allowance windows. The account email, organization,
// and config paths `claude auth status` prints are dropped here, and no
// credential ever passes through — it stays in the provider's own storage.
import { interpretCodexRateLimits } from '../provider-probe/interpret.js';

export type SetupProvider = 'claude' | 'codex';
export const SETUP_PROVIDERS: readonly SetupProvider[] = ['claude', 'codex'];
export const PROVIDER_NAMES: Record<SetupProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export type ProviderReadinessState =
  | 'ready'
  | 'missing-cli'
  | 'signed-out'
  | 'expired'
  | 'allowance-reached'
  | 'check-failed';

export interface ReadinessAllowanceWindow {
  window: string;
  usedPercent: number;
  /** ISO time (Codex) or the provider's own reset text (Claude `/usage`). */
  resetsAt?: string;
}

export interface ProviderReadinessAssessment {
  state: ProviderReadinessState;
  /** One plain sentence about what the check found. */
  detail: string;
  cliVersion?: string;
  /** How the CLI is signed in, e.g. `claude.ai`, `console`, `chatgpt`, `api-key`. Never an identity. */
  authMethod?: string;
  plan?: string;
  allowance?: ReadinessAllowanceWindow[];
}

export interface CommandEvidence {
  exitCode: number | null;
  stdout: string;
  /** Some CLIs report status on stderr (`codex login status` does). */
  stderr?: string;
  /** Set when the command could not run or did not finish (e.g. `timed out`). */
  failure?: string;
}

export type ClaudeEvidence =
  | { installed: false }
  | { installed: true; version?: string; authStatus: CommandEvidence; usage?: CommandEvidence };

/** The app-server `account/rateLimits/read` answer, or why there was none. */
export type CodexRateLimitsRead = { result: unknown } | { error: string; timedOut?: boolean };

export type CodexEvidence =
  | { installed: false }
  | {
    installed: true;
    version?: string;
    loginStatus: CommandEvidence;
    rateLimits?: CodexRateLimitsRead;
  };

type Json = Record<string, unknown>;

function parseObject(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function semver(text: string | undefined): string | undefined {
  return text?.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function missing(provider: SetupProvider): ProviderReadinessAssessment {
  return { state: 'missing-cli', detail: `${PROVIDER_NAMES[provider]} is not installed on this Mac.` };
}

/** Reads the text `claude -p /usage` prints, e.g. "Current session: 26% used · resets Sep 27 at 9pm". */
export function parseClaudeUsageWindows(text: string): ReadinessAllowanceWindow[] {
  return [...text.matchAll(/^(Current [^:\n]+): (\d+)% used(?:\s*·\s*resets ([^\n]+))?/gm)].map((match) => ({
    window: match[1]!.trim(),
    usedPercent: Number(match[2]),
    ...(match[3] ? { resetsAt: match[3].trim() } : {}),
  }));
}

const SIGN_IN_REFUSED = /not logged in|\/login|log ?in again|sign ?in again|expired|unauthori[sz]ed|\b401\b|authentication required|invalid (?:api key|token|grant)|revoked/i;

function reachedDetail(provider: SetupProvider, windows: ReadinessAllowanceWindow[]): string {
  const full = windows.find((window) => window.usedPercent >= 100);
  const reset = full?.resetsAt ? ` It resets ${formatReset(full.resetsAt)}.` : '';
  return `${PROVIDER_NAMES[provider]} has used its plan allowance${full ? ` for ${full.window.toLowerCase()}` : ''}.${reset}`;
}

function formatReset(resetsAt: string): string {
  const time = Date.parse(resetsAt);
  return /^\d{4}-\d{2}-\d{2}T/.test(resetsAt) && Number.isFinite(time) ? new Date(time).toLocaleString() : resetsAt;
}

export function assessClaudeReadiness(evidence: ClaudeEvidence): ProviderReadinessAssessment {
  if (!evidence.installed) return missing('claude');
  const cliVersion = semver(evidence.version);
  const base = cliVersion ? { cliVersion } : {};
  const status = parseObject(evidence.authStatus.stdout);
  if (!status || evidence.authStatus.failure) {
    return { ...base, state: 'check-failed', detail: `Claude Code did not report its sign-in${evidence.authStatus.failure ? ` (${evidence.authStatus.failure})` : ''}.` };
  }
  if (status.loggedIn !== true) return { ...base, state: 'signed-out', detail: 'Claude Code is not signed in.' };

  const authMethod = str(status.authMethod);
  const plan = str(status.subscriptionType);
  const signedIn = { ...base, ...(authMethod ? { authMethod } : {}), ...(plan ? { plan } : {}) };
  const usage = evidence.usage;
  const result = usage ? parseObject(usage.stdout) : undefined;
  if (!usage || !result || usage.failure) {
    return { ...signedIn, state: 'check-failed', detail: `Claude Code is signed in, but the readiness check did not finish${usage?.failure ? ` (${usage.failure})` : ''}.` };
  }
  const text = str(result.result) ?? '';
  if (result.is_error === true) {
    return SIGN_IN_REFUSED.test(text)
      ? { ...signedIn, state: 'expired', detail: 'Claude Code’s sign-in has expired or was revoked.' }
      : { ...signedIn, state: 'check-failed', detail: 'Claude Code could not complete the readiness check.' };
  }
  if (authMethod !== 'claude.ai') {
    // Console and API-key sign-ins bill per use; `/usage` prints a cost
    // summary and there is no plan allowance to report.
    return { ...signedIn, state: 'ready', detail: 'Claude Code is signed in and answered the readiness check.' };
  }
  const allowance = parseClaudeUsageWindows(text);
  if (allowance.length > 0) {
    return allowance.some((window) => window.usedPercent >= 100)
      ? { ...signedIn, allowance, state: 'allowance-reached', detail: reachedDetail('claude', allowance) }
      : { ...signedIn, allowance, state: 'ready', detail: 'Claude Code is signed in and your subscription answered.' };
  }
  if (SIGN_IN_REFUSED.test(text)) {
    return { ...signedIn, state: 'expired', detail: 'Claude Code’s sign-in has expired or was revoked.' };
  }
  // Without the plan's windows `/usage` prints only a local cost summary.
  // That was observed signed out, but it is not proof of an expired sign-in,
  // so this stays a failed check whose repair offers both retry and sign-in.
  return { ...signedIn, state: 'check-failed', detail: 'Claude Code says it is signed in, but your subscription did not answer. If checking again does not help, sign in again.' };
}

export function assessCodexReadiness(evidence: CodexEvidence): ProviderReadinessAssessment {
  if (!evidence.installed) return missing('codex');
  const cliVersion = semver(evidence.version);
  const base = cliVersion ? { cliVersion } : {};
  const login = evidence.loginStatus;
  const loginText = `${login.stdout}\n${login.stderr ?? ''}`;
  if (login.failure && login.exitCode === null) {
    return { ...base, state: 'check-failed', detail: `Codex did not report its sign-in (${login.failure}).` };
  }
  if (login.exitCode !== 0 || /not logged in/i.test(loginText)) return { ...base, state: 'signed-out', detail: 'Codex is not signed in.' };

  const authMethod = /api key/i.test(loginText) ? 'api-key' : /chatgpt/i.test(loginText) ? 'chatgpt' : undefined;
  const signedIn = { ...base, ...(authMethod ? { authMethod } : {}) };
  if (authMethod === 'api-key') {
    return { ...signedIn, state: 'ready', detail: 'Codex is signed in with an API key, billed per use.' };
  }
  const limits = evidence.rateLimits;
  if (!limits) return { ...signedIn, state: 'check-failed', detail: 'Codex is signed in, but the readiness check did not run.' };
  if ('error' in limits) {
    return !limits.timedOut && SIGN_IN_REFUSED.test(limits.error)
      ? { ...signedIn, state: 'expired', detail: 'Codex’s sign-in has expired or was revoked.' }
      : { ...signedIn, state: 'check-failed', detail: 'Codex is signed in, but its plan allowance could not be read.' };
  }
  const read = interpretCodexRateLimits(limits.result);
  const withPlan = { ...signedIn, ...(read.planType ? { plan: read.planType } : {}), allowance: read.allowance };
  return read.allowanceReached
    ? { ...withPlan, state: 'allowance-reached', detail: reachedDetail('codex', read.allowance) }
    : { ...withPlan, state: 'ready', detail: 'Codex is signed in and your plan answered.' };
}

export type RepairAction = 'install' | 'open-install-guide' | 'sign-in' | 'check';

export interface RepairGuide {
  title: string;
  steps: string[];
  actions: RepairAction[];
}

/**
 * What the owner can do about each state. Installation runs only the
 * provider's official installer (Claude Code's native installer), or opens
 * the provider's own install page; sign-in is always the provider's own
 * browser flow.
 */
export function repairFor(provider: SetupProvider, state: ProviderReadinessState): RepairGuide {
  const name = PROVIDER_NAMES[provider];
  switch (state) {
    case 'ready':
      return { title: `${name} is ready`, steps: [], actions: ['check'] };
    case 'missing-cli':
      return provider === 'claude'
        ? {
          title: 'Install Claude Code',
          steps: [
            'Choose Install Claude Code. AgentDeck runs Anthropic’s official installer, which puts Claude Code in your home folder. No administrator password is needed.',
            'When it finishes, AgentDeck checks the installation automatically.',
          ],
          actions: ['install', 'check'],
        }
        : {
          title: 'Install Codex',
          steps: [
            'Choose Open install page to see OpenAI’s supported ways to install Codex on a Mac.',
            'After installing, come back and choose Check again.',
          ],
          actions: ['open-install-guide', 'check'],
        };
    case 'signed-out':
      return {
        title: `Sign in to ${name}`,
        steps: [
          `Choose Sign in. Your browser opens ${provider === 'claude' ? 'Anthropic' : 'OpenAI'}’s own sign-in page.`,
          'Sign in there with your own account. AgentDeck never sees or stores your password or key.',
          'Come back here when the browser says you are done.',
        ],
        actions: ['sign-in'],
      };
    case 'expired':
      return {
        title: `Sign in to ${name} again`,
        steps: [
          'Your sign-in expired, was revoked, or belongs to a different account now.',
          'Choose Sign in to sign in again in your browser, then AgentDeck checks it again.',
        ],
        actions: ['sign-in', 'check'],
      };
    case 'allowance-reached':
      return {
        title: 'Plan allowance used up',
        steps: [
          'Your plan’s allowance for this period is used up. Signing in again will not help.',
          'Wait until it resets, or change your plan with the provider, then choose Check again.',
        ],
        actions: ['check'],
      };
    case 'check-failed':
      return {
        title: 'Could not finish the check',
        steps: [
          'Make sure this Mac is online, then choose Check again.',
          `If it keeps failing, sign in again, or reinstall ${name}.`,
        ],
        actions: ['check', 'sign-in'],
      };
  }
}
