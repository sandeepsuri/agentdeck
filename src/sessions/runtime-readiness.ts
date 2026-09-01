import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentExecutable } from './executable.js';
import type { AgentType } from '../types.js';
import {
  MANAGED_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_LABELS,
  type ManagedRuntimeCapability,
  type RuntimeCapabilityReadiness,
  type RuntimeReadiness,
  type RuntimeReadinessReport,
} from './runtime-readiness-contract.js';

export type {
  ManagedRuntimeCapability,
  RuntimeCapabilityReadiness,
  RuntimeReadiness,
  RuntimeReadinessReport,
  RuntimeReadinessStatus,
} from './runtime-readiness-contract.js';

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
  inspectCodexProtocol?: (executable: string) => Promise<CodexProtocolEvidence>;
  now?: () => Date;
}

export type CodexProtocolEvidence = Readonly<Record<ManagedRuntimeCapability, boolean>>;

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
  inspectCodexProtocol?: (executable: string) => Promise<CodexProtocolEvidence>;
  now?: () => Date;
  resolveExecutable?: (runtime: AgentType) => string | undefined;
}

const RUNTIMES: { runtime: AgentType; displayName: string }[] = [
  { runtime: 'codex', displayName: 'Codex CLI' },
  { runtime: 'claude', displayName: 'Claude Code' },
];

const CAPABILITY_REASONS: Record<ManagedRuntimeCapability, string> = {
  'structured-events': 'The installed CLI does not expose a structured event transport.',
  continuation: 'The installed CLI does not expose structured conversation continuation.',
  approvals: 'The installed CLI does not expose managed approval controls.',
  'usage-reporting': 'The installed CLI does not expose usage through its structured transport.',
  'execution-restrictions': 'The installed CLI does not expose restricted execution controls.',
};

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
    .map((item) => RUNTIME_CAPABILITY_LABELS[item.capability].toLocaleLowerCase());
  return missing.length === 0
    ? 'All managed-run capabilities are available.'
    : `Missing managed-run capabilities: ${missing.join(', ')}.`;
}

interface CommandProbe {
  text: string;
  failure?: string;
}

function commandFailure(error: unknown): string {
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (candidate.code === 'ETIMEDOUT' || candidate.killed === true || candidate.signal === 'SIGTERM') {
    return 'timed out';
  }
  if (candidate.code === 'ENOENT') return 'could not be executed';
  if (typeof candidate.code === 'number') return `exited with code ${candidate.code}`;
  return 'failed';
}

async function commandText(
  options: RuntimeReadinessProbeOptions,
  executable: string,
  args: readonly string[],
): Promise<CommandProbe> {
  try {
    const result = await options.run(executable, args);
    return { text: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    return {
      text: '',
      failure: `${path.basename(executable)} ${args.join(' ')} ${commandFailure(error)}`,
    };
  }
}

function reasonWithFailures(
  capabilities: RuntimeCapabilityReadiness[],
  failures: readonly (string | undefined)[],
  detail?: string,
): string {
  const failureReasons = failures.filter((failure): failure is string => Boolean(failure));
  return [
    readinessReason(capabilities),
    detail,
    failureReasons.length > 0 ? `Inspection failures: ${failureReasons.join('; ')}.` : undefined,
  ].filter(Boolean).join(' ');
}

function parseCodexVersion(output: string): string | undefined {
  return output.match(/\bcodex-cli\s+([0-9][0-9A-Za-z.+-]*)\b/i)?.[1];
}

async function probeCodex(
  options: RuntimeReadinessProbeOptions,
  executable: string,
): Promise<RuntimeReadiness> {
  const [versionOutput, appServerHelp, schemaHelp, protocol] = await Promise.all([
    commandText(options, executable, ['--version']),
    commandText(options, executable, ['app-server', '--help']),
    commandText(options, executable, ['app-server', 'generate-json-schema', '--help']),
    options.inspectCodexProtocol?.(executable)
      .then((evidence) => ({ evidence }))
      .catch((error: unknown) => ({ failure: `codex protocol schema ${commandFailure(error)}` }))
      ?? Promise.resolve({ failure: 'codex protocol schema inspection is unavailable' }),
  ]);
  const hasAppServer = /\bapp server\b/i.test(appServerHelp.text) && appServerHelp.text.includes('stdio://');
  const hasSchemaGenerator = /generate json schema/i.test(schemaHelp.text) && schemaHelp.text.includes('--out');
  const evidence = 'evidence' in protocol ? protocol.evidence : undefined;
  const capabilities = [
    capability('structured-events', hasAppServer && hasSchemaGenerator && evidence?.['structured-events'] === true),
    capability('continuation', evidence?.continuation === true),
    capability('approvals', evidence?.approvals === true),
    capability('usage-reporting', evidence?.['usage-reporting'] === true),
    capability('execution-restrictions', evidence?.['execution-restrictions'] === true),
  ];
  const version = parseCodexVersion(versionOutput.text);
  const unavailable = Boolean(versionOutput.failure && appServerHelp.failure && !versionOutput.text && !appServerHelp.text);
  return {
    runtime: 'codex',
    displayName: 'Codex CLI',
    status: unavailable ? 'unavailable' : capabilities.every((item) => item.supported) ? 'managed' : 'compatibility-only',
    ...(version ? { version } : {}),
    reason: reasonWithFailures(capabilities, [
      versionOutput.failure,
      appServerHelp.failure,
      schemaHelp.failure,
      'failure' in protocol ? protocol.failure : undefined,
    ]),
    capabilities,
  };
}

function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:\(Claude Code\))?/i)?.[1];
}

// 2.1.208 is the first Claude Code line where invalid stream-json control
// requests return a structured error instead of leaving the host waiting.
// Managed approvals need that bidirectional control-channel baseline.
const CLAUDE_MANAGED_PROTOCOL_MIN_VERSION = [2, 1, 208] as const;

function supportsClaudeManagedProtocol(version: string | undefined): boolean {
  if (!version) return false;
  const parts = version.split('.').slice(0, 3).map(Number);
  for (const [index, minimum] of CLAUDE_MANAGED_PROTOCOL_MIN_VERSION.entries()) {
    const actual = parts[index] ?? 0;
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

async function probeClaude(
  options: RuntimeReadinessProbeOptions,
  executable: string,
): Promise<RuntimeReadiness> {
  const [versionOutput, help] = await Promise.all([
    commandText(options, executable, ['--version']),
    commandText(options, executable, ['--help']),
  ]);
  const hasStreamJson = help.text.includes('--output-format') && help.text.includes('stream-json');
  const hasStreamInput = help.text.includes('--input-format') && help.text.includes('stream-json');
  const hasHookEvents = help.text.includes('--include-hook-events');
  const version = parseClaudeVersion(versionOutput.text);
  const hasManagedProtocol = supportsClaudeManagedProtocol(version);
  const capabilities = [
    capability('structured-events', help.text.includes('--print') && help.text.includes('--verbose')
      && hasStreamJson && hasStreamInput && hasHookEvents),
    capability('continuation', help.text.includes('--resume') && help.text.includes('--session-id') && hasStreamInput),
    capability('approvals', hasManagedProtocol && help.text.includes('--permission-mode') && hasStreamInput),
    capability('usage-reporting', hasManagedProtocol && hasStreamJson && help.text.includes('--max-budget-usd')),
    capability('execution-restrictions', help.text.includes('--restricted') && help.text.includes('--allowedTools')
      && help.text.includes('--disallowedTools') && help.text.includes('--strict-mcp-config')
      && help.text.includes('--setting-sources') && help.text.includes('--bare') && help.text.includes('--safe-mode')),
  ];
  const unavailable = Boolean(versionOutput.failure && help.failure && !versionOutput.text && !help.text);
  const versionDetail = hasManagedProtocol
    ? undefined
    : `Managed approval and usage protocols require Claude Code ${CLAUDE_MANAGED_PROTOCOL_MIN_VERSION.join('.')} or newer.`;
  return {
    runtime: 'claude',
    displayName: 'Claude Code',
    status: unavailable ? 'unavailable' : capabilities.every((item) => item.supported) ? 'managed' : 'compatibility-only',
    ...(version ? { version } : {}),
    reason: reasonWithFailures(capabilities, [versionOutput.failure, help.failure], versionDetail),
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

async function generateCodexProtocolEvidence(
  executable: string,
  run: RuntimeReadinessProbeOptions['run'],
): Promise<CodexProtocolEvidence> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentdeck-codex-protocol-'));
  const read = async (relativePath: string) => {
    try {
      return await fs.promises.readFile(path.join(directory, relativePath), 'utf8');
    } catch {
      return '';
    }
  };
  try {
    await run(executable, ['app-server', 'generate-json-schema', '--out', directory, '--experimental']);
    const [notifications, resumeParams, resumeResponse, approvalParams, approvalResponse, usage, threadStart] = await Promise.all([
      read('ServerNotification.json'),
      read('v2/ThreadResumeParams.json'),
      read('v2/ThreadResumeResponse.json'),
      read('CommandExecutionRequestApprovalParams.json'),
      read('CommandExecutionRequestApprovalResponse.json'),
      read('v2/ThreadTokenUsageUpdatedNotification.json'),
      read('v2/ThreadStartParams.json'),
    ]);
    return {
      'structured-events': ['turn/started', 'turn/completed', 'item/started', 'item/completed']
        .every((method) => notifications.includes(method)),
      continuation: Boolean(resumeParams && resumeResponse),
      approvals: Boolean(approvalParams && approvalResponse),
      'usage-reporting': usage.includes('inputTokens') && usage.includes('outputTokens'),
      'execution-restrictions': threadStart.includes('"sandbox"')
        && threadStart.includes('"approvalPolicy"') && threadStart.includes('"cwd"')
        && threadStart.includes('"runtimeWorkspaceRoots"') && threadStart.includes('"environments"'),
    };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export function createRuntimeReadinessSource(
  options: CreateRuntimeReadinessSourceOptions = {},
): RuntimeReadinessSource {
  const environment = options.environment ?? process.env;
  const execute = options.execute ?? executeProbe;
  const executionOptions = (executable: string): RuntimeProbeExecutionOptions => {
    const pathEntries = [path.dirname(executable), path.dirname(process.execPath), ...(environment.PATH ?? '/usr/bin:/bin').split(path.delimiter)];
    return {
      encoding: 'utf8',
      env: {
        PATH: [...new Set(pathEntries.filter(Boolean))].join(path.delimiter),
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    };
  };
  const run = (executable: string, args: readonly string[]) => execute(executable, args, executionOptions(executable));
  return {
    get: () => probeRuntimeReadiness({
      now: options.now,
      resolveExecutable: options.resolveExecutable ?? resolveAgentExecutable,
      run,
      inspectCodexProtocol: options.inspectCodexProtocol
        ?? ((executable) => generateCodexProtocolEvidence(executable, run)),
    }),
  };
}
