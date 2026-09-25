// Ticket E00: reproducible probes of the Claude Code and Codex CLIs for
// everyday (non-coding) personal work on the owner's own subscription.
// Findings and the provider decision live in
// docs/adr/0002-first-personal-task-provider.md.
//
// Usage: npm run probe:providers -- [--provider claude|codex|all] [--failures]
//   --failures  also runs the signed-out and offline probes (the offline
//               probe waits for its 45 s deadline, so this adds ~2 minutes)
//
// Every run spends a small amount of the signed-in plan's allowance. Probes
// run in a fresh empty temp folder, never in a repository, with the CLI's
// own tools disabled or read-only. No credential is ever read: the storage
// probe only checks where one lives. The report is redacted before it is
// written to .scratch/provider-probes/ (gitignored) or printed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  interpretClaudeStream,
  interpretCodexExec,
  interpretCodexRateLimits,
  type ProbeOutcome,
  type ProbeStatus,
  type ProcessExit,
} from '../src/provider-probe/interpret.js';
import { redactProbeText } from '../src/provider-probe/redact.js';

type Provider = 'claude' | 'codex';

interface Expectation {
  status: ProbeStatus;
  /** The structured output must match EMAIL_SCHEMA exactly. */
  schemaValid?: boolean;
}

interface ProbeRecord {
  provider: Provider;
  probe: string;
  expected: Expectation;
  durationMs: number;
  outcome: ProbeOutcome;
  detail?: unknown;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const providerArg = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'all';
const includeFailures = args.includes('--failures');
const providers: Provider[] = providerArg === 'claude' || providerArg === 'codex' ? [providerArg] : ['claude', 'codex'];

const DEADLINE_MS = 120_000;
const FAILURE_DEADLINE_MS = 45_000;
const INTERRUPT_AFTER_MS = 4_000;

const redact = (text: string): string => redactProbeText(text, { home: os.homedir() });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-provider-probe-'));
const workDir = path.join(scratch, 'work');
fs.mkdirSync(workDir);

// OpenAI structured outputs require every property listed in `required` and
// `additionalProperties: false`; Claude accepts that shape too, so both
// providers get the identical schema.
const CATEGORIES = ['invoice', 'personal', 'newsletter', 'other'];
const EMAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    reply_needed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['category', 'reply_needed', 'summary'],
};
// An ordinary JSON Schema with an optional property: the schema-strictness probe.
const LOOSE_SCHEMA = {
  type: 'object',
  properties: { category: { type: 'string' }, note: { type: 'string' } },
  required: ['category'],
};
const schemaPath = path.join(scratch, 'email-schema.json');
const looseSchemaPath = path.join(scratch, 'loose-schema.json');
fs.writeFileSync(schemaPath, JSON.stringify(EMAIL_SCHEMA));
fs.writeFileSync(looseSchemaPath, JSON.stringify(LOOSE_SCHEMA));

const CLASSIFY_PROMPT = 'Classify this email. From: Dana <dana@example.com>. Subject: Dinner Friday? '
  + 'Body: Are you free for dinner Friday at 7? Let me know.';
const LONG_PROMPT = 'Write a 400-word note on why people should back up their photos, then list 5 tips.';

interface RunResult { stdout: string; stderr: string; exit: ProcessExit; durationMs: number }

function run(
  command: string,
  commandArgs: readonly string[],
  options: { env?: NodeJS.ProcessEnv; deadlineMs?: number; killAfterMs?: number } = {},
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: workDir, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // An explicit empty stdin: both CLIs otherwise wait on a piped stdin.
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.min(options.killAfterMs ?? Infinity, options.deadlineMs ?? DEADLINE_MS));
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit: { code, signal }, durationMs: Date.now() - started });
    });
  });
}

interface ProviderSpec {
  /** Arguments for a tool-free (Claude) or read-only (Codex) non-interactive turn. */
  base: string[];
  schemaArgs(schema: object, schemaFile: string): string[];
  /** Environment that points the CLI at an empty config directory, i.e. signed out. */
  signedOutEnv(emptyDir: string): NodeJS.ProcessEnv;
  interpret(stdout: string, exit: ProcessExit): ProbeOutcome;
}

const PROVIDERS: Record<Provider, ProviderSpec> = {
  claude: {
    base: ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'],
    schemaArgs: (schema) => ['--json-schema', JSON.stringify(schema)],
    signedOutEnv: (emptyDir) => ({ ...process.env, CLAUDE_CONFIG_DIR: emptyDir }),
    interpret: interpretClaudeStream,
  },
  codex: {
    base: ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only'],
    schemaArgs: (_schema, schemaFile) => ['--output-schema', schemaFile],
    signedOutEnv: (emptyDir) => ({ ...process.env, CODEX_HOME: emptyDir }),
    interpret: interpretCodexExec,
  },
};

function classifyArgs(provider: Provider, schema: object = EMAIL_SCHEMA, schemaFile = schemaPath): string[] {
  const spec = PROVIDERS[provider];
  return [...spec.base, ...spec.schemaArgs(schema, schemaFile), CLASSIFY_PROMPT];
}

function record(provider: Provider, probe: string, expected: Expectation, result: RunResult, detail?: unknown): ProbeRecord {
  return { provider, probe, expected, durationMs: result.durationMs, outcome: PROVIDERS[provider].interpret(result.stdout, result.exit), ...(detail ? { detail } : {}) };
}

/** Parses the text `/usage` prints, e.g. "Current session: 26% used · resets …". */
function claudeUsageText(text: string): { window: string; usedPercent: number }[] {
  return [...text.matchAll(/^(Current [^:]+): (\d+)% used/gm)].map((match) => ({ window: match[1] ?? '', usedPercent: Number(match[2]) }));
}

async function readiness(provider: Provider): Promise<ProbeRecord> {
  const started = Date.now();
  const version = (await run(provider, ['--version'])).stdout.trim();
  if (provider === 'claude') {
    const status = await run('claude', ['auth', 'status']);
    let auth: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
      auth = { loggedIn: parsed.loggedIn, authMethod: parsed.authMethod, subscriptionType: parsed.subscriptionType };
    } catch {
      auth = { unreadable: true };
    }
    // `/usage` is answered locally (0 turns), so it spends no allowance.
    const usage = await run('claude', ['-p', '/usage', '--output-format', 'json', '--setting-sources', '', '--no-session-persistence']);
    let onDemandAllowance: unknown;
    try {
      const parsed = JSON.parse(usage.stdout) as { num_turns?: number; result?: string };
      onDemandAllowance = { turns: parsed.num_turns, windows: claudeUsageText(parsed.result ?? '') };
    } catch {
      onDemandAllowance = { unreadable: true };
    }
    const signedIn = status.exit.code === 0 && auth.loggedIn === true;
    return {
      provider, probe: 'readiness', expected: { status: 'ok' }, durationMs: Date.now() - started,
      outcome: { status: signedIn ? 'ok' : 'signed-out', reason: signedIn ? 'Signed in.' : 'claude auth status reports signed out.' },
      detail: { version, auth, onDemandAllowance },
    };
  }
  const status = await run('codex', ['login', 'status']);
  const allowance = await codexAllowance();
  const signedIn = status.exit.code === 0;
  const reached = typeof allowance === 'object' && allowance !== null && (allowance as { allowanceReached?: boolean }).allowanceReached === true;
  const outcomeStatus: ProbeStatus = !signedIn ? 'signed-out' : reached ? 'allowance-reached' : 'ok';
  return {
    provider, probe: 'readiness', expected: { status: 'ok' }, durationMs: Date.now() - started,
    outcome: { status: outcomeStatus, reason: (status.stdout + status.stderr).trim() },
    detail: { version, onDemandAllowance: allowance },
  };
}

/** `account/rateLimits/read` over `codex app-server`; spends no allowance. */
async function codexAllowance(): Promise<unknown> {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdeck-probe', version: '0' } } },
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' },
  ].map((request) => JSON.stringify(request)).join('\n');
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], { cwd: workDir, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); resolve({ error: 'no rate-limit response within 15s' }); }, 15_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve(message.result ? interpretCodexRateLimits(message.result) : { error: message.error });
          }
        } catch {
          // partial line
        }
      }
    });
    child.stdin.write(`${requests}\n`);
  });
}

/** Where the provider keeps its credential. Never reads the credential itself. */
async function credentialStorage(provider: Provider): Promise<unknown> {
  if (provider === 'claude') {
    const keychain = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials']);
    return {
      keychainItem: keychain.exit.code === 0,
      credentialsFile: fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json')),
    };
  }
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const authFile = path.join(codexHome, 'auth.json');
  const config = fs.existsSync(path.join(codexHome, 'config.toml')) ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') : '';
  return {
    authFile: fs.existsSync(authFile) ? { mode: (fs.statSync(authFile).mode & 0o777).toString(8) } : false,
    configuredStore: /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? 'default',
  };
}

/** Which tools the model is offered on the tool-free/read-only turn. */
async function toolSurface(provider: Provider, structuredRun: RunResult): Promise<unknown> {
  if (provider === 'claude') {
    for (const line of structuredRun.stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; subtype?: string; tools?: unknown };
        if (event.type === 'system' && event.subtype === 'init') return { toolsOffered: event.tools };
      } catch {
        // not JSON
      }
    }
    return { toolsOffered: 'unknown' };
  }
  // codex exec prints no tool list; the evidence is that no flag can remove its shell.
  const help = (await run('codex', ['exec', '--help'])).stdout;
  return { flagToDisableTools: /--(tools|disable-tools|no-tools)\b/.test(help), sandbox: 'read-only' };
}

async function structured(provider: Provider): Promise<ProbeRecord> {
  const result = await run(provider, classifyArgs(provider));
  return record(provider, 'structured-output', { status: 'ok', schemaValid: true }, result, {
    toolSurface: await toolSurface(provider, result),
    credentialStorage: await credentialStorage(provider),
  });
}

async function looseSchema(provider: Provider): Promise<ProbeRecord> {
  const result = await run(provider, classifyArgs(provider, LOOSE_SCHEMA, looseSchemaPath));
  // Observed: Claude accepts an ordinary schema; OpenAI strict mode rejects it.
  return record(provider, 'loose-schema', { status: provider === 'claude' ? 'ok' : 'invalid-schema' }, result);
}

async function interruptThenRetry(provider: Provider): Promise<ProbeRecord[]> {
  const killed = await run(provider, [...PROVIDERS[provider].base, LONG_PROMPT], { killAfterMs: INTERRUPT_AFTER_MS });
  // A retry is a fresh attempt with the same input, not a resumed provider
  // conversation: it must not depend on anything the killed attempt left.
  const retried = await run(provider, classifyArgs(provider));
  return [
    record(provider, 'interrupt', { status: 'interrupted' }, killed, { exit: killed.exit }),
    record(provider, 'retry-after-interrupt', { status: 'ok', schemaValid: true }, retried),
  ];
}

async function signedOut(provider: Provider): Promise<ProbeRecord> {
  const emptyDir = fs.mkdtempSync(path.join(scratch, `${provider}-signed-out-`));
  const result = await run(provider, classifyArgs(provider), { env: PROVIDERS[provider].signedOutEnv(emptyDir), deadlineMs: FAILURE_DEADLINE_MS });
  return record(provider, 'signed-out', { status: 'signed-out' }, result);
}

async function offline(provider: Provider): Promise<ProbeRecord> {
  // Port 9 (discard) refuses connections, so every request fails fast and the
  // CLI's own retry policy is what the probe observes, until the deadline.
  const dead = 'http://127.0.0.1:9';
  const env = { ...process.env, HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead };
  const result = await run(provider, classifyArgs(provider), { env, deadlineMs: FAILURE_DEADLINE_MS });
  return record(provider, 'offline', { status: 'network-unavailable' }, result);
}

function matchesEmailSchema(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const value = output as Record<string, unknown>;
  return Object.keys(value).sort().join() === [...EMAIL_SCHEMA.required].sort().join()
    && CATEGORIES.includes(value.category as string)
    && typeof value.reply_needed === 'boolean'
    && typeof value.summary === 'string';
}

function passes(probe: ProbeRecord): boolean {
  return probe.outcome.status === probe.expected.status
    && (!probe.expected.schemaValid || matchesEmailSchema(probe.outcome.structuredOutput));
}

async function main(): Promise<void> {
  const records: ProbeRecord[] = [];
  for (const provider of providers) {
    records.push(await readiness(provider));
    records.push(await structured(provider));
    records.push(await looseSchema(provider));
    records.push(...await interruptThenRetry(provider));
    if (includeFailures) {
      records.push(await signedOut(provider));
      records.push(await offline(provider));
    }
  }

  const report = { capturedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, records };
  const outDir = path.join(root, '.scratch', 'provider-probes');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${report.capturedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, redact(JSON.stringify(report, null, 2)));
  fs.rmSync(scratch, { recursive: true, force: true });

  for (const probe of records) {
    const tokens = probe.outcome.tokens ? ` tokens=${probe.outcome.tokens.input}/${probe.outcome.tokens.output}` : '';
    const allowance = probe.outcome.allowance?.map((w) => `${w.window}:${w.usedPercent}%`).join(',') ?? '';
    console.log(`${passes(probe) ? 'PASS' : 'FAIL'}  ${probe.provider.padEnd(6)} ${probe.probe.padEnd(22)} ${probe.outcome.status.padEnd(19)} ${String(probe.durationMs).padStart(6)}ms${tokens}${allowance ? ` allowance=${allowance}` : ''}`);
    if (!passes(probe)) console.log(`      expected ${probe.expected.status}: ${redact(probe.outcome.reason)}`);
    if (probe.detail) console.log(`      ${redact(JSON.stringify(probe.detail))}`);
  }
  console.log(`\nRedacted report: ${path.relative(root, outPath)}`);
  if (records.some((probe) => !passes(probe))) process.exitCode = 1;
}

await main();
