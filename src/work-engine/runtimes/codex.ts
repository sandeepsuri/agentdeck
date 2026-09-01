// Codex runtime adapter (ticket 05): drives one structured Attempt over the
// `codex app-server` JSON-RPC-over-stdio protocol (the same transport ticket
// 01's readiness probe already inspects — see generateCodexProtocolEvidence
// in sessions/runtime-readiness.ts for the schema evidence this adapter's
// method/notification names are drawn from: v2 thread lifecycle, item
// started/completed, ThreadTokenUsageUpdatedNotification for usage).
//
// No AgentDeck-managed credential is ever passed to the process — env is
// filtered through the frozen capability envelope's allowlist (ticket 04),
// which always includes HOME, so Codex authenticates the same way it
// already does interactively: its own stored ChatGPT subscription login
// under ~/.codex. That satisfies "existing subscription authentication".
//
// Provider conversation identity (the Codex threadId) lives only in this
// module's closures — it is never put on an AttemptEvent, never reaches
// WorkRun/Store (ticket 05 AC3/AC4).
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolveAgentExecutable } from '../../sessions/executable.js';
import { filterEnvironment } from '../envelope.js';
import type { AttemptEvent } from '../types.js';
import type { AttemptLaunchContext, RuntimeAttemptAdapter } from './adapter.js';

export interface CodexAttemptProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves once the process has exited, however it exited. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export type CodexProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>> },
) => CodexAttemptProcess;

export interface CreateCodexAttemptAdapterOptions {
  resolveExecutable?: () => string | undefined;
  spawn?: CodexProcessSpawner;
  now?: () => Date;
}

const defaultSpawn: CodexProcessSpawner = (executable, args, options) => {
  const child = nodeSpawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exited,
    kill: () => child.kill(),
  };
};

async function* readLines(stream: Readable): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
      index = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest.length > 0) yield rest;
}

/** A minimal single-producer async queue: notifications push in, the generator consumes in order. */
class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null;
}

function itemSummary(item: Record<string, unknown>): string | undefined {
  if (typeof item.command === 'string') return item.command;
  if (Array.isArray(item.command)) return item.command.filter((part) => typeof part === 'string').join(' ');
  if (typeof item.path === 'string') return item.path;
  return undefined;
}

function buildPrompt(context: AttemptLaunchContext): string {
  const criteria = context.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  return `${context.objective}\n\nAcceptance criteria:\n${criteria}`;
}

export function createCodexAttemptAdapter(
  options: CreateCodexAttemptAdapterOptions = {},
): RuntimeAttemptAdapter {
  const resolveExecutable = options.resolveExecutable ?? (() => resolveAgentExecutable('codex'));
  const spawnProcess = options.spawn ?? defaultSpawn;
  const nowFn = options.now ?? (() => new Date());

  async function* run(context: AttemptLaunchContext): AsyncIterable<AttemptEvent> {
    const now = () => nowFn().toISOString();
    let sequence = 0;
    yield { kind: 'lifecycle', sequence: sequence++, at: now(), phase: 'attempt-started' };

    const executable = resolveExecutable();
    if (!executable) {
      yield { kind: 'failure', sequence: sequence++, at: now(), reason: 'Codex CLI is not installed or is not executable.' };
      return;
    }

    const env = filterEnvironment(context.profile, process.env);
    const proc = spawnProcess(executable, ['app-server'], { cwd: context.worktreePath, env });

    const queue = new AsyncEventQueue<AttemptEvent>();
    const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    let terminal = false;
    let hadActivity = false;
    let requestId = 0;

    const pushEvent = (event: AttemptEvent): void => {
      if (terminal) return;
      queue.push(event);
      if (event.kind === 'completion' || event.kind === 'failure') {
        terminal = true;
        queue.close();
      }
    };
    const emitFailure = (reason: string): void => pushEvent({ kind: 'failure', sequence: sequence++, at: now(), reason });
    const emitCompletion = (): void => pushEvent({
      kind: 'completion', sequence: sequence++, at: now(), outcome: hadActivity ? 'success' : 'no-changes',
    });

    const send = (method: string, params: unknown): number => {
      const id = ++requestId;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return id;
    };
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = send(method, params);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };

    function handleNotification(method: string, params: Record<string, unknown>): void {
      switch (method) {
        case 'turn/started':
          pushEvent({ kind: 'lifecycle', sequence: sequence++, at: now(), phase: 'turn-started' });
          return;
        case 'item/started': {
          const item = (params.item ?? {}) as Record<string, unknown>;
          if (typeof item.type === 'string' && item.type !== 'agent_message') {
            hadActivity = true;
            const summary = itemSummary(item);
            pushEvent({
              kind: 'tool-activity', sequence: sequence++, at: now(), tool: item.type, status: 'started',
              ...(summary ? { summary } : {}),
            });
          }
          return;
        }
        case 'item/completed': {
          const item = (params.item ?? {}) as Record<string, unknown>;
          if (item.type === 'agent_message') {
            hadActivity = true;
            pushEvent({
              kind: 'message', sequence: sequence++, at: now(), role: 'assistant',
              text: typeof item.text === 'string' ? item.text : '',
            });
          } else if (typeof item.type === 'string') {
            hadActivity = true;
            const summary = itemSummary(item);
            pushEvent({
              kind: 'tool-activity', sequence: sequence++, at: now(), tool: item.type,
              status: item.status === 'failed' ? 'failed' : 'completed',
              ...(summary ? { summary } : {}),
            });
          }
          return;
        }
        case 'thread/tokenUsageUpdated':
          pushEvent({
            kind: 'usage', sequence: sequence++, at: now(),
            inputTokens: typeof params.inputTokens === 'number' ? params.inputTokens : 'unknown',
            outputTokens: typeof params.outputTokens === 'number' ? params.outputTokens : 'unknown',
          });
          return;
        case 'turn/completed': {
          pushEvent({ kind: 'lifecycle', sequence: sequence++, at: now(), phase: 'turn-completed' });
          const error = params.error as { message?: string } | undefined;
          if (error) emitFailure(typeof error.message === 'string' ? error.message : 'Codex reported a turn failure.');
          else emitCompletion();
          return;
        }
        case 'session/error':
          emitFailure(typeof params.message === 'string' ? params.message : 'Codex reported a session error.');
          return;
        default:
          // Unrecognized notifications are ignored rather than fabricated
          // into a structured event (ticket 05 AC6's spirit, applied to the
          // structured transport too, not only raw PTY bytes).
          return;
      }
    }

    function handleLine(line: string): void {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isJsonRpcMessage(message)) return;
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && typeof message.method !== 'string') {
        const waiter = pending.get(message.id as number);
        pending.delete(message.id as number);
        if (!waiter) return;
        if (message.error) waiter.reject(new Error(message.error.message ?? 'Codex app-server returned an error.'));
        else waiter.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== 'string') return;
      if (message.id !== undefined) {
        // A server-to-client request (e.g. an approval) — ticket 07 owns
        // real approval routing; decline safely here so the turn can never
        // hang waiting for a reply this adapter has no policy path for.
        proc.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Managed Attempts do not support interactive approvals yet.' },
        })}\n`);
        return;
      }
      handleNotification(message.method, message.params ?? {});
    }

    const pumpDone = (async () => {
      try {
        for await (const line of readLines(proc.stdout)) {
          handleLine(line);
          if (terminal) return;
        }
      } catch (error) {
        emitFailure(`Codex app-server stream failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!terminal) {
        const exit = await proc.exited;
        emitFailure(
          `Codex app-server exited before completing the Attempt${exit.code !== null ? ` (exit code ${exit.code})` : ''}`
          + `${exit.signal ? ` (signal ${exit.signal})` : ''}.`,
        );
      }
    })().finally(() => queue.close());

    try {
      await request('initialize', { clientInfo: { name: 'agentdeck', version: '1' } });
      const threadStart = await request('thread/start', {
        cwd: context.worktreePath,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        runtimeWorkspaceRoots: [context.worktreePath],
      });
      const threadId = typeof threadStart.threadId === 'string' ? threadStart.threadId : undefined;
      if (!threadId) throw new Error('Codex app-server did not return a thread id.');
      send('thread/sendMessage', { threadId, text: buildPrompt(context) });
    } catch (error) {
      emitFailure(error instanceof Error ? error.message : String(error));
    }

    try {
      for await (const event of queue) {
        yield event;
        if (event.kind === 'completion' || event.kind === 'failure') break;
      }
    } finally {
      proc.kill();
      await pumpDone.catch(() => undefined);
    }
  }

  return { runtime: 'codex', run };
}
