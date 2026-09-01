import { execFile } from 'node:child_process';
import { resolveAgentExecutable } from './executable.js';
import type { AgentType } from '../types.js';

export type RuntimeReadinessStatus = 'managed' | 'compatibility-only' | 'unavailable';

export type ManagedRuntimeCapability =
  | 'structured-events'
  | 'continuation'
  | 'approvals'
  | 'usage-reporting'
  | 'execution-restrictions';

export interface RuntimeCapabilityReadiness {
  capability: ManagedRuntimeCapability;
  supported: boolean;
  reason?: string;
}

export interface RuntimeReadiness {
  runtime: AgentType;
  displayName: string;
  status: RuntimeReadinessStatus;
  version?: string;
  reason: string;
  capabilities: RuntimeCapabilityReadiness[];
}

export interface RuntimeReadinessReport {
  checkedAt: string;
  runtimes: RuntimeReadiness[];
}

export function publicRuntimeReadinessReport(report: RuntimeReadinessReport): RuntimeReadinessReport {
  return {
    checkedAt: report.checkedAt,
    runtimes: report.runtimes.map((runtime) => ({
      runtime: runtime.runtime,
      displayName: runtime.displayName,
      status: runtime.status,
      ...(runtime.version ? { version: runtime.version } : {}),
      reason: runtime.reason,
      capabilities: runtime.capabilities.map((item) => ({
        capability: item.capability,
        supported: item.supported,
        ...(item.reason ? { reason: item.reason } : {}),
      })),
    })),
  };
}

export interface RuntimeReadinessSource {
  get(): Promise<RuntimeReadinessReport>;
}

export interface RuntimeProbeCommandResult {
  stdout: string;
  stderr: string;
}

export interface RuntimeReadinessProbeOptions {
  resolveExecutable: (runtime: AgentType) => string | undefined;
  run: (executable: string, args: readonly string[]) => Promise<RuntimeProbeCommandResult>;
  now?: () => Date;
}

export interface RuntimeProbeExecutionOptions {
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

export type RuntimeProbeExecutor = (
  executable: string,
  args: readonly string[],
  options: RuntimeProbeExecutionOptions,
) => Promise<RuntimeProbeCommandResult>;

export interface CreateRuntimeReadinessSourceOptions {
  environment?: NodeJS.ProcessEnv;
  execute?: RuntimeProbeExecutor;
  now?: () => Date;
  resolveExecutable?: (runtime: AgentType) => string | undefined;
}

const RUNTIMES: { runtime: AgentType; displayName: string }[] = [
  { runtime: 'codex', displayName: 'Codex CLI' },
  { runtime: 'claude', displayName: 'Claude Code' },
];

const CAPABILITY_LABELS: Record<ManagedRuntimeCapability, string> = {
  'structured-events': 'structured events',
  continuation: 'continuation',
  approvals: 'approvals',
  'usage-reporting': 'usage reporting',
  'execution-restrictions': 'execution restrictions',
};

const CAPABILITY_REASONS: Record<ManagedRuntimeCapability, string> = {
  'structured-events': 'The installed CLI does not expose a structured event transport.',
  continuation: 'The installed CLI does not expose structured conversation continuation.',
  approvals: 'The installed CLI does not expose managed approval controls.',
  'usage-reporting': 'The installed CLI does not expose usage through its structured transport.',
  'execution-restrictions': 'The installed CLI does not expose restricted execution controls.',
};

const MANAGED_RUNTIME_CAPABILITIES: ManagedRuntimeCapability[] = [
  'structured-events',
  'continuation',
  'approvals',
  'usage-reporting',
  'execution-restrictions',
];

function capability(
  name: ManagedRuntimeCapability,
  supported: boolean,
): RuntimeCapabilityReadiness {
  return supported
    ? { capability: name, supported: true }
    : { capability: name, supported: false, reason: CAPABILITY_REASONS[name] };
}

function readinessReason(capabilities: RuntimeCapabilityReadiness[]): string {
  const missing = capabilities.filter((item) => !item.supported)
    .map((item) => CAPABILITY_LABELS[item.capability]);
  return missing.length === 0
    ? 'All managed-run capabilities are available.'
    : `Missing managed-run capabilities: ${missing.join(', ')}.`;
}

async function commandText(
  options: RuntimeReadinessProbeOptions,
  executable: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await options.run(executable, args);
    return `${result.stdout}\n${result.stderr}`;
  } catch {
    return '';
  }
}

function parseCodexVersion(output: string): string | undefined {
  return output.match(/\bcodex-cli\s+([0-9][0-9A-Za-z.+-]*)\b/i)?.[1];
}

async function probeCodex(
  options: RuntimeReadinessProbeOptions,
  executable: string,
): Promise<RuntimeReadiness> {
  const [versionOutput, rootHelp, execHelp, resumeHelp, appServerHelp] = await Promise.all([
    commandText(options, executable, ['--version']),
    commandText(options, executable, ['--help']),
    commandText(options, executable, ['exec', '--help']),
    commandText(options, executable, ['exec', 'resume', '--help']),
    commandText(options, executable, ['app-server', '--help']),
  ]);
  const hasAppServer = /\bapp server\b/i.test(appServerHelp) && appServerHelp.includes('stdio://');
  const hasJsonEvents = execHelp.includes('--json');
  const capabilities = [
    capability('structured-events', hasAppServer && hasJsonEvents),
    capability('continuation', /\bresume\b/i.test(resumeHelp) && resumeHelp.includes('--json')),
    capability('approvals', hasAppServer && rootHelp.includes('--ask-for-approval')),
    capability('usage-reporting', hasAppServer && hasJsonEvents),
    capability('execution-restrictions', rootHelp.includes('--sandbox')
      && rootHelp.includes('--add-dir') && execHelp.includes('--ignore-user-config')),
  ];
  const reason = readinessReason(capabilities);
  return {
    runtime: 'codex',
    displayName: 'Codex CLI',
    status: capabilities.every((item) => item.supported) ? 'managed' : 'compatibility-only',
    ...(parseCodexVersion(versionOutput) ? { version: parseCodexVersion(versionOutput) } : {}),
    reason,
    capabilities,
  };
}

function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:\(Claude Code\))?/i)?.[1];
}

async function probeClaude(
  options: RuntimeReadinessProbeOptions,
  executable: string,
): Promise<RuntimeReadiness> {
  const [versionOutput, help] = await Promise.all([
    commandText(options, executable, ['--version']),
    commandText(options, executable, ['--help']),
  ]);
  const hasStreamJson = help.includes('--output-format') && help.includes('stream-json');
  const hasStreamInput = help.includes('--input-format') && help.includes('stream-json');
  const hasHookEvents = help.includes('--include-hook-events');
  const capabilities = [
    capability('structured-events', help.includes('--print') && hasStreamJson && hasStreamInput && hasHookEvents),
    capability('continuation', help.includes('--resume') && help.includes('--session-id') && hasStreamInput),
    capability('approvals', help.includes('--permission-mode') && hasHookEvents),
    capability('usage-reporting', hasStreamJson && help.includes('--max-budget-usd')),
    capability('execution-restrictions', help.includes('--restricted') && help.includes('--allowedTools')
      && help.includes('--disallowedTools') && help.includes('--strict-mcp-config')
      && help.includes('--setting-sources')),
  ];
  const version = parseClaudeVersion(versionOutput);
  return {
    runtime: 'claude',
    displayName: 'Claude Code',
    status: capabilities.every((item) => item.supported) ? 'managed' : 'compatibility-only',
    ...(version ? { version } : {}),
    reason: readinessReason(capabilities),
    capabilities,
  };
}

export async function probeRuntimeReadiness(
  options: RuntimeReadinessProbeOptions,
): Promise<RuntimeReadinessReport> {
  const runtimes = await Promise.all(RUNTIMES.map(async ({ runtime, displayName }): Promise<RuntimeReadiness> => {
    const executable = options.resolveExecutable(runtime);
    if (!executable) {
      return {
        runtime,
        displayName,
        status: 'unavailable',
        reason: `${displayName} is not installed or is not executable.`,
        capabilities: MANAGED_RUNTIME_CAPABILITIES.map((name) => capability(name, false)),
      };
    }
    return runtime === 'codex'
      ? probeCodex(options, executable)
      : probeClaude(options, executable);
  }));
  return { checkedAt: (options.now?.() ?? new Date()).toISOString(), runtimes };
}

const executeProbe: RuntimeProbeExecutor = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, [...args], options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

export function createRuntimeReadinessSource(
  options: CreateRuntimeReadinessSourceOptions = {},
): RuntimeReadinessSource {
  const environment = options.environment ?? process.env;
  const execute = options.execute ?? executeProbe;
  const probeEnvironment: NodeJS.ProcessEnv = {
    PATH: environment.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
  };
  return {
    get: () => probeRuntimeReadiness({
      now: options.now,
      resolveExecutable: options.resolveExecutable ?? resolveAgentExecutable,
      run: (executable, args) => execute(executable, args, {
        encoding: 'utf8',
        env: probeEnvironment,
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      }),
    }),
  };
}
