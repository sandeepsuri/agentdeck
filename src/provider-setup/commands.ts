// Issue #85: runs the provider CLIs for ProviderSetupService. Every process
// runs in its own process group, so a timeout, cancel, or shutdown also stops
// the native binary an npm-installed wrapper starts. Checks run in a private
// empty folder, so a CLI never reads a repository's settings.
//
// The environment is rebuilt rather than inherited: enough for the CLI to
// find its own sign-in (HOME, USER, the config-directory overrides) and its
// runtime (PATH), and no API key or token from AgentDeck's environment.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentExecutable } from '../sessions/executable.js';
import type { CodexRateLimitsRead, CommandEvidence, SetupProvider } from './readiness.js';
import type { LongProcess, ProviderCommands } from './service.js';

const PASSED_THROUGH = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function providerEnvironment(executable: string | undefined, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: source.LANG ?? 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb' };
  for (const name of PASSED_THROUGH) if (source[name]) env[name] = source[name];
  // An npm-installed CLI starts with `#!/usr/bin/env node`; its own bin
  // folder usually holds that node, and AgentDeck's runtime is the fallback.
  const entries = [
    ...(executable ? [path.dirname(executable)] : []),
    path.dirname(process.execPath),
    ...(source.PATH ?? '').split(path.delimiter),
    ...SYSTEM_PATH,
  ].filter(Boolean);
  env.PATH = [...new Set(entries)].join(path.delimiter);
  return env;
}

/** Process groups still running, so shutdown can stop checks too. */
const live = new Set<number>();

function trackGroup(pid: number | undefined): void {
  if (pid) live.add(pid);
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  const force = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 2000);
  force.unref();
}

function withScratch<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-provider-check-'));
  return work(cwd).finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

function runOnce(executable: string, args: readonly string[], timeoutMs: number, cwd: string): Promise<CommandEvidence> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let failure: string | undefined;
    const child = spawn(executable, [...args], { cwd, env: providerEnvironment(executable), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    trackGroup(child.pid);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => { failure = 'timed out'; killGroup(child.pid); }, timeoutMs);
    child.on('error', () => { failure ??= 'could not be run'; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid) live.delete(child.pid);
      resolve({ exitCode: failure ? null : code, stdout, stderr, ...(failure ? { failure } : {}) });
    });
  });
}

function readRateLimits(executable: string, cwd: string): Promise<CodexRateLimitsRead> {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdeck-setup', version: '1' } } },
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' },
  ].map((request) => JSON.stringify(request)).join('\n');
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const child = spawn(executable, ['app-server'], { cwd, env: providerEnvironment(executable), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    trackGroup(child.pid);
    const finish = (value: CodexRateLimitsRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      if (child.pid) live.delete(child.pid);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: 'Codex did not answer within 15 seconds.', timedOut: true }), 15_000);
    child.on('error', () => finish({ error: 'codex app-server could not be run' }));
    child.on('close', () => finish({ error: 'codex app-server stopped before answering' }));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (message.id !== 2) continue;
          finish(message.result !== undefined ? { result: message.result } : { error: message.error?.message ?? 'Codex refused the request.' });
        } catch { /* not a JSON-RPC line */ }
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${requests}\n`);
  });
}

function startProcess(command: string, args: readonly string[], stdin: boolean): LongProcess {
  const child = spawn(command, [...args], {
    cwd: os.homedir(),
    env: providerEnvironment(command),
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
  trackGroup(child.pid);
  const outputListeners: ((text: string) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  const emit = (chunk: Buffer) => { for (const listener of outputListeners) listener(chunk.toString('utf8')); };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.stdin?.on('error', () => undefined);
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    if (child.pid) live.delete(child.pid);
    for (const listener of exitListeners) listener(code);
  };
  child.on('error', () => exit(null));
  child.on('close', (code) => exit(code));
  return {
    onOutput: (listener) => { outputListeners.push(listener); },
    onExit: (listener) => { exitListeners.push(listener); },
    write: (text) => { child.stdin?.write(text); },
    kill: () => killGroup(child.pid),
  };
}

export function macProviderCommands(options: { locate?: (provider: SetupProvider) => string | undefined } = {}): ProviderCommands {
  return {
    locate: options.locate ?? resolveAgentExecutable,
    run: (executable, args, { timeoutMs }) => withScratch((cwd) => runOnce(executable, args, timeoutMs, cwd)),
    readCodexRateLimits: (executable) => withScratch((cwd) => readRateLimits(executable, cwd)),
    start: (command, args, { stdin }) => startProcess(command, args, stdin),
    openUrl: (url) => new Promise((resolve, reject) => {
      if (!url.startsWith('https://')) { reject(new Error('Only https pages can be opened.')); return; }
      execFile('/usr/bin/open', [url], (error) => (error ? reject(error) : resolve()));
    }),
    stopAll: () => { for (const pid of live) killGroup(pid); live.clear(); },
  };
}
