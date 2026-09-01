import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadinessSource, probeRuntimeReadiness } from './runtime-readiness.js';

const fullCodexProtocol = {
  'structured-events': true,
  continuation: true,
  approvals: true,
  'usage-reporting': true,
  'execution-restrictions': true,
} as const;

const fullClaudeHelp = [
  '--print',
  '--verbose',
  '--output-format <format> stream-json',
  '--input-format <format> stream-json',
  '--include-hook-events',
  '--resume <session-id>',
  '--session-id <uuid>',
  '--permission-mode <mode>',
  '--max-budget-usd <amount>',
  '--restricted',
  '--allowedTools <tools>',
  '--disallowedTools <tools>',
  '--strict-mcp-config',
  '--setting-sources <sources>',
  '--bare',
  '--safe-mode',
].join('\n');

const unavailableCapabilities = [
  {
    capability: 'structured-events',
    supported: false,
    reason: 'The installed CLI does not expose a structured event transport.',
  },
  {
    capability: 'continuation',
    supported: false,
    reason: 'The installed CLI does not expose structured conversation continuation.',
  },
  {
    capability: 'approvals',
    supported: false,
    reason: 'The installed CLI does not expose managed approval controls.',
  },
  {
    capability: 'usage-reporting',
    supported: false,
    reason: 'The installed CLI does not expose usage through its structured transport.',
  },
  {
    capability: 'execution-restrictions',
    supported: false,
    reason: 'The installed CLI does not expose restricted execution controls.',
  },
] as const;

describe('probeRuntimeReadiness', () => {
  it('reports each missing runtime as unavailable without executing a command', async () => {
    const run = vi.fn();

    const report = await probeRuntimeReadiness({
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: () => undefined,
      run,
    });

    expect({ report, commandCount: run.mock.calls.length }).toEqual({
      report: {
        checkedAt: '2026-09-01T14:00:00.000Z',
        runtimes: [
          {
            runtime: 'codex',
            displayName: 'Codex CLI',
            status: 'unavailable',
            reason: 'Codex CLI is not installed or is not executable.',
            capabilities: unavailableCapabilities,
          },
          {
            runtime: 'claude',
            displayName: 'Claude Code',
            status: 'unavailable',
            reason: 'Claude Code is not installed or is not executable.',
            capabilities: unavailableCapabilities,
          },
        ],
      },
      commandCount: 0,
    });
  });

  it('reports Codex as managed when its non-running CLI surfaces the full contract', async () => {
    const outputs: Record<string, string> = {
      '--version': 'codex-cli 0.152.0',
      'app-server --help': 'Run the app server\n--listen <URL>\nstdio://',
      'app-server generate-json-schema --help': 'Generate JSON Schema\n--out <DIR>',
    };

    const report = await probeRuntimeReadiness({
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
      inspectCodexProtocol: async () => fullCodexProtocol,
      run: vi.fn(async (_executable: string, args: readonly string[]) => ({
        stdout: outputs[args.join(' ')] ?? '',
        stderr: '',
      })),
    });

    expect(report).toEqual({
      checkedAt: '2026-09-01T14:00:00.000Z',
      runtimes: [
        {
          runtime: 'codex',
          displayName: 'Codex CLI',
          status: 'managed',
          version: '0.152.0',
          reason: 'All managed-run capabilities are available.',
          capabilities: [
            { capability: 'structured-events', supported: true },
            { capability: 'continuation', supported: true },
            { capability: 'approvals', supported: true },
            { capability: 'usage-reporting', supported: true },
            { capability: 'execution-restrictions', supported: true },
          ],
        },
        {
          runtime: 'claude',
          displayName: 'Claude Code',
          status: 'unavailable',
          reason: 'Claude Code is not installed or is not executable.',
          capabilities: unavailableCapabilities,
        },
      ],
    });
  });

  it('reports Claude as managed when its non-running CLI surfaces the full contract', async () => {
    const report = await probeRuntimeReadiness({
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: (runtime) => runtime === 'claude' ? '/private/bin/claude' : undefined,
      run: vi.fn(async (_executable: string, args: readonly string[]) => ({
        stdout: args[0] === '--version' ? '2.1.251 (Claude Code)' : fullClaudeHelp,
        stderr: '',
      })),
    });

    expect(report.runtimes[1]).toEqual({
      runtime: 'claude',
      displayName: 'Claude Code',
      status: 'managed',
      version: '2.1.251',
      reason: 'All managed-run capabilities are available.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        { capability: 'execution-restrictions', supported: true },
      ],
    });
  });

  it('keeps pre-baseline Claude installations compatibility-only with a precise version reason', async () => {
    const report = await probeRuntimeReadiness({
      resolveExecutable: (runtime) => runtime === 'claude' ? '/private/bin/claude' : undefined,
      run: vi.fn(async (_executable: string, args: readonly string[]) => ({
        stdout: args[0] === '--version' ? '2.1.207 (Claude Code)' : fullClaudeHelp,
        stderr: '',
      })),
    });

    expect(report.runtimes[1]).toMatchObject({
      runtime: 'claude',
      status: 'compatibility-only',
      reason: 'Missing managed-run capabilities: approvals, usage reporting. Managed approval and usage protocols require Claude Code 2.1.208 or newer.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: false },
        { capability: 'usage-reporting', supported: false },
        { capability: 'execution-restrictions', supported: true },
      ],
    });
  });

  it('reports an installed but unsupported runtime as compatibility-only with exact missing capabilities', async () => {
    const outputs: Record<string, string> = {
      '--version': 'codex-cli 0.99.0',
      'app-server --help': 'Run the app server\n--listen <URL>\nstdio://',
      'app-server generate-json-schema --help': 'Generate JSON Schema\n--out <DIR>',
    };

    const report = await probeRuntimeReadiness({
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
      inspectCodexProtocol: async () => ({ ...fullCodexProtocol, 'execution-restrictions': false }),
      run: vi.fn(async (_executable: string, args: readonly string[]) => ({
        stdout: outputs[args.join(' ')] ?? '',
        stderr: '',
      })),
    });

    expect(report.runtimes[0]).toMatchObject({
      runtime: 'codex',
      status: 'compatibility-only',
      reason: 'Missing managed-run capabilities: execution restrictions.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        {
          capability: 'execution-restrictions',
          supported: false,
          reason: 'The installed CLI does not expose restricted execution controls.',
        },
      ],
    });
  });

  it('reports an installed runtime as unavailable with a precise sanitized probe failure', async () => {
    const timedOut = Object.assign(new Error('raw error with /private/config'), { code: 'ETIMEDOUT' });

    const report = await probeRuntimeReadiness({
      resolveExecutable: (runtime) => runtime === 'claude' ? '/private/bin/claude' : undefined,
      run: vi.fn(async () => { throw timedOut; }),
    });

    expect(report.runtimes[1]).toMatchObject({
      runtime: 'claude',
      status: 'unavailable',
      reason: expect.stringContaining('Inspection failures: claude --version timed out; claude --help timed out.'),
    });
    expect(JSON.stringify(report.runtimes[1])).not.toContain('/private/config');
  });
});

describe('createRuntimeReadinessSource', () => {
  it('uses only inert commands and excludes auth and provider configuration from probes and reports', async () => {
    const calls: { executable: string; args: readonly string[]; options: unknown }[] = [];
    const source = createRuntimeReadinessSource({
      environment: {
        PATH: '/safe/bin',
        OPENAI_API_KEY: 'sk-private',
        ANTHROPIC_API_KEY: 'anthropic-private',
        CODEX_HOME: '/private/codex-home',
        CLAUDE_CONFIG_DIR: '/private/claude-home',
      },
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: (runtime) => `/private/bin/${runtime}`,
      inspectCodexProtocol: async () => fullCodexProtocol,
      execute: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return {
          stdout: 'unrecognized old runtime',
          stderr: 'sk-private anthropic-private /private/codex-home hidden_provider=true',
        };
      },
    });

    const report = await source.get();

    expect({
      commands: calls.map((call) => `${call.executable.split('/').pop()} ${call.args.join(' ')}`),
      options: calls.map((call) => call.options),
      exposesSensitiveOutput: /sk-private|anthropic-private|codex-home|hidden_provider/.test(JSON.stringify(report)),
    }).toEqual({
      commands: [
        'codex --version',
        'codex app-server --help',
        'codex app-server generate-json-schema --help',
        'claude --version',
        'claude --help',
      ],
      options: Array.from({ length: 5 }, () => ({
        encoding: 'utf8',
        env: {
          PATH: ['/private/bin', path.dirname(process.execPath), '/safe/bin'].join(path.delimiter),
          LANG: 'C',
          LC_ALL: 'C',
          NO_COLOR: '1',
        },
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      })),
      exposesSensitiveOutput: false,
    });
  });

  it('refuses managed status when the generated protocol exposes no turn/start for the objective', async () => {
    // A CLI whose notification schema looks complete but whose client-request
    // schema has no objective-carrying request cannot run a managed Attempt —
    // the adapter would have nothing to hand the objective to.
    const source = createRuntimeReadinessSource({
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
      execute: async (_executable, args) => {
        if (args[0] === '--version') return { stdout: 'codex-cli 0.152.0', stderr: '' };
        if (args.join(' ') === 'app-server --help') return { stdout: 'Run the app server\nstdio://', stderr: '' };
        if (args.join(' ') === 'app-server generate-json-schema --help') {
          return { stdout: 'Generate JSON Schema\n--out <DIR>', stderr: '' };
        }
        const outIndex = args.indexOf('--out');
        if (outIndex >= 0) {
          const directory = args[outIndex + 1]!;
          fs.mkdirSync(path.join(directory, 'v2'), { recursive: true });
          fs.writeFileSync(path.join(directory, 'ServerNotification.json'), 'turn/started turn/completed item/started item/completed');
          fs.writeFileSync(path.join(directory, 'ClientRequest.json'), '"thread/start" "thread/resume"');
        }
        return { stdout: '', stderr: '' };
      },
    });

    const report = await source.get();

    expect(report.runtimes[0]).toMatchObject({
      runtime: 'codex',
      status: 'compatibility-only',
      capabilities: expect.arrayContaining([{
        capability: 'structured-events',
        supported: false,
        reason: expect.any(String),
      }]),
    });
  });

  it('derives the Codex contract from generated protocol schemas without starting a Run', async () => {
    const commands: string[] = [];
    const source = createRuntimeReadinessSource({
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
      execute: async (_executable, args) => {
        commands.push(args.join(' '));
        if (args[0] === '--version') return { stdout: 'codex-cli 0.152.0', stderr: '' };
        if (args.join(' ') === 'app-server --help') {
          return { stdout: 'Run the app server\nstdio://', stderr: '' };
        }
        if (args.join(' ') === 'app-server generate-json-schema --help') {
          return { stdout: 'Generate JSON Schema\n--out <DIR>', stderr: '' };
        }
        const outIndex = args.indexOf('--out');
        if (outIndex >= 0) {
          const directory = args[outIndex + 1]!;
          fs.mkdirSync(path.join(directory, 'v2'), { recursive: true });
          fs.writeFileSync(path.join(directory, 'ServerNotification.json'), 'turn/started turn/completed item/started item/completed');
          fs.writeFileSync(path.join(directory, 'ClientRequest.json'), '"turn/start"');
          fs.writeFileSync(path.join(directory, 'CommandExecutionRequestApprovalParams.json'), '{}');
          fs.writeFileSync(path.join(directory, 'CommandExecutionRequestApprovalResponse.json'), '{}');
          fs.writeFileSync(path.join(directory, 'v2/ThreadResumeParams.json'), '{}');
          fs.writeFileSync(path.join(directory, 'v2/ThreadResumeResponse.json'), '{}');
          fs.writeFileSync(path.join(directory, 'v2/ThreadTokenUsageUpdatedNotification.json'), 'inputTokens outputTokens');
          fs.writeFileSync(path.join(directory, 'v2/ThreadStartParams.json'), '"cwd" "sandbox" "approvalPolicy" "runtimeWorkspaceRoots" "environments"');
        }
        return { stdout: '', stderr: '' };
      },
    });

    const report = await source.get();

    expect({ runtime: report.runtimes[0], commands }).toMatchObject({
      runtime: {
        runtime: 'codex',
        status: 'managed',
        capabilities: [
          { capability: 'structured-events', supported: true },
          { capability: 'continuation', supported: true },
          { capability: 'approvals', supported: true },
          { capability: 'usage-reporting', supported: true },
          { capability: 'execution-restrictions', supported: true },
        ],
      },
      commands: [
        '--version',
        'app-server --help',
        'app-server generate-json-schema --help',
        expect.stringMatching(/^app-server generate-json-schema --out .* --experimental$/),
      ],
    });
  });
});
