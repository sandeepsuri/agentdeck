import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadinessSource, probeRuntimeReadiness } from './runtime-readiness.js';

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
      '--help': 'Commands: exec app-server\n--sandbox <MODE>\n--ask-for-approval <POLICY>\n--add-dir <DIR>',
      'exec --help': '--json\n--sandbox <MODE>\n--ask-for-approval <POLICY>\n--ignore-user-config',
      'exec resume --help': 'Resume a previous session\n--json\nSESSION_ID',
      'app-server --help': 'Run the app server\n--listen <URL>\nstdio://',
    };

    const report = await probeRuntimeReadiness({
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
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
    const help = [
      '--print',
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
    ].join('\n');

    const report = await probeRuntimeReadiness({
      now: () => new Date('2026-09-01T14:00:00.000Z'),
      resolveExecutable: (runtime) => runtime === 'claude' ? '/private/bin/claude' : undefined,
      run: vi.fn(async (_executable: string, args: readonly string[]) => ({
        stdout: args[0] === '--version' ? '2.1.251 (Claude Code)' : help,
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

  it('reports an installed but unsupported runtime as compatibility-only with exact missing capabilities', async () => {
    const outputs: Record<string, string> = {
      '--version': 'codex-cli 0.99.0',
      '--help': 'Commands: exec app-server\n--sandbox <MODE>\n--ask-for-approval <POLICY>\n--add-dir <DIR>',
      'exec --help': '--json\n--sandbox <MODE>\n--ask-for-approval <POLICY>',
      'exec resume --help': 'Resume a previous session\n--json\nSESSION_ID',
      'app-server --help': 'Run the app server\n--listen <URL>\nstdio://',
    };

    const report = await probeRuntimeReadiness({
      resolveExecutable: (runtime) => runtime === 'codex' ? '/private/bin/codex' : undefined,
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
        'codex --help',
        'codex exec --help',
        'codex exec resume --help',
        'codex app-server --help',
        'claude --version',
        'claude --help',
      ],
      options: Array.from({ length: 7 }, () => ({
        encoding: 'utf8',
        env: { PATH: '/safe/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      })),
      exposesSensitiveOutput: false,
    });
  });
});
