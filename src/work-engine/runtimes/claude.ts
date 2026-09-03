// Claude runtime adapter (ticket 14): drives one structured Attempt over
// `claude -p --output-format stream-json --input-format stream-json`, the
// same line-delimited JSON transport ticket 01's readiness probe already
// inspects (see probeClaude in sessions/runtime-readiness.ts for the flag
// evidence this adapter's invocation is drawn from). Event shapes below
// (system/init, assistant text/tool_use, user/tool_result, result) were
// captured from a real installed Claude Code CLI (2.1.x), not guessed.
//
// No AgentDeck-managed credential is ever passed to the process — env is
// filtered through the frozen capability envelope's allowlist (ticket 04),
// which always includes HOME, so Claude Code authenticates the same way it
// already does interactively: its own stored subscription/API-key login
// under ~/.claude. That satisfies "existing subscription authentication".
//
// `--setting-sources ''` and `--strict-mcp-config` keep the process from
// picking up the operator's own hooks, custom commands, or MCP servers —
// none of which AgentDeck's capability envelope grants or can bound — while
// still leaving CLAUDE.md project context and every built-in tool available.
// `--permission-mode bypassPermissions --permission-prompts none` means the
// CLI never blocks on an interactive approval it has nobody to ask (this
// adapter does not yet relay attention requests the way runtimes/codex.ts
// does for Codex — see the module-level TODO below): the envelope's own
// worktree containment and environment allowlist are the actual boundary,
// exactly the stance codex.ts already takes ("AgentDeck's own capability
// envelope is what already bounds what an approved command could do
// regardless of this policy").
//
// Provider conversation identity (the Claude session_id) lives only in this
// module's closures — it is never put on an AttemptEvent, never reaches
// WorkRun/Store (ticket 05 AC3/AC4, extended to Claude by ticket 14).
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolveAgentExecutable } from '../../sessions/executable.js';
import { filterEnvironment } from '../envelope.js';
import type { AttemptEvent } from '../types.js';
import type { AttemptLaunchContext, RuntimeAttemptAdapter } from './adapter.js';

export interface ClaudeAttemptProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves once the process has exited, however it exited. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export type ClaudeProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>> },
) => ClaudeAttemptProcess;

export interface CreateClaudeAttemptAdapterOptions {
  resolveExecutable?: () => string | undefined;
  spawn?: ClaudeProcessSpawner;
  now?: () => Date;
}

const defaultSpawn: ClaudeProcessSpawner = (executable, args, options) => {
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

/** A minimal single-producer async queue: parsed stream events push in, the generator consumes in order. */
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

/** Every stream-json line is a flat `{ type, ... }` object — never wrapped in a JSON-RPC envelope the way Codex's app-server protocol is. */
function isStreamMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The identifying detail of a tool_use block's input, by the field the tool actually carries it under. Raw fact for the durable log — wording is attemptActivity.ts's job. */
function toolSummary(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.command === 'string') return record.command;
  if (typeof record.file_path === 'string') return record.file_path;
  if (typeof record.pattern === 'string') return record.pattern;
  if (typeof record.query === 'string') return record.query;
  if (typeof record.url === 'string') return record.url;
  if (typeof record.description === 'string') return record.description;
  return undefined;
}

function usageAmount(value: unknown): number | 'unknown' {
  return typeof value === 'number' ? value : 'unknown';
}

function buildPrompt(context: AttemptLaunchContext): string {
  const criteria = context.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  return `${context.objective}\n\nAcceptance criteria:\n${criteria}`;
}

export function createClaudeAttemptAdapter(
  options: CreateClaudeAttemptAdapterOptions = {},
): RuntimeAttemptAdapter {
  const resolveExecutable = options.resolveExecutable ?? (() => resolveAgentExecutable('claude'));
  const spawnProcess = options.spawn ?? defaultSpawn;
  const nowFn = options.now ?? (() => new Date());

  async function* run(context: AttemptLaunchContext): AsyncIterable<AttemptEvent> {
    const now = () => nowFn().toISOString();
    let sequence = 0;
    yield { kind: 'lifecycle', sequence: sequence++, at: now(), phase: 'attempt-started' };

    const executable = resolveExecutable();
    if (!executable) {
      yield { kind: 'failure', sequence: sequence++, at: now(), reason: 'Claude Code CLI is not installed or is not executable.' };
      return;
    }

    const env = filterEnvironment(context.profile, process.env);
    const proc = spawnProcess(executable, [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompts', 'none',
      '--setting-sources', '',
      '--strict-mcp-config',
    ], { cwd: context.worktreePath, env });
    // Ticket 09 AC5/AC1: kills the real process the instant the engine asks
    // to stop, independent of wherever this generator happens to be
    // suspended — see runtimes/codex.ts's identical use of abortRequested.
    void context.abortRequested?.then(() => proc.kill());

    const queue = new AsyncEventQueue<AttemptEvent>();
    let terminal = false;
    let hadActivity = false;
    // Maps a tool_use block's id to the tool name and summary its own
    // 'assistant' event carried, so the matching 'user'/tool_result event
    // (which names only the id) can report a completed/failed activity for
    // that same tool rather than losing its identity.
    const pendingTools = new Map<string, { tool: string; summary?: string }>();

    const pushEvent = (event: AttemptEvent): void => {
      if (terminal) return;
      queue.push(event);
      if (event.kind === 'completion' || event.kind === 'failure') {
        terminal = true;
        queue.close();
      }
    };
    const emitFailure = (reason: string): void => pushEvent({ kind: 'failure', sequence: sequence++, at: now(), reason });
    const emitCompletion = (summary: string | undefined): void => pushEvent({
      kind: 'completion',
      sequence: sequence++,
      at: now(),
      outcome: hadActivity ? 'success' : 'no-changes',
      ...(summary ? { summary } : {}),
    });

    function handleAssistantMessage(message: Record<string, unknown>): void {
      const content = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          hadActivity = true;
          pushEvent({ kind: 'message', sequence: sequence++, at: now(), role: 'assistant', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          hadActivity = true;
          const summary = toolSummary(block.input);
          pendingTools.set(block.id, { tool: block.name, ...(summary ? { summary } : {}) });
          pushEvent({
            kind: 'tool-activity', sequence: sequence++, at: now(), tool: block.name, status: 'started',
            ...(summary ? { summary } : {}),
          });
        }
        // 'thinking' / 'redacted_thinking' blocks are the model's internal
        // reasoning, never an action — recording either as tool-activity
        // would be a category error, exactly as codex.ts treats 'reasoning'.
      }
    }

    function handleUserMessage(message: Record<string, unknown>): void {
      const content = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
      for (const block of content) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const known = pendingTools.get(block.tool_use_id);
        // No matching tool_use seen: never fabricate a tool name for a
        // result this adapter cannot identify.
        if (!known) continue;
        hadActivity = true;
        pushEvent({
          kind: 'tool-activity', sequence: sequence++, at: now(), tool: known.tool,
          status: block.is_error === true ? 'failed' : 'completed',
          ...(known.summary ? { summary: known.summary } : {}),
        });
      }
    }

    function handleResult(message: Record<string, unknown>): void {
      // The one usage figure this adapter reports: `result.usage` is the
      // whole Attempt's total (every turn, every message), unlike each
      // individual 'assistant' message's own `usage` field, which counts
      // only that message's own request — reporting the per-message figure
      // here would make the running total shrink back down on the very
      // last message, the same trap Codex's own comment (thread/start's
      // ThreadTokenUsage.total) already calls out.
      const usage = (message.usage ?? undefined) as Record<string, unknown> | undefined;
      if (usage) {
        pushEvent({
          kind: 'usage', sequence: sequence++, at: now(),
          inputTokens: usageAmount(usage.input_tokens),
          outputTokens: usageAmount(usage.output_tokens),
        });
      }
      const isError = message.is_error === true
        || (typeof message.subtype === 'string' && message.subtype !== 'success');
      if (isError) {
        const errors = Array.isArray(message.errors)
          ? message.errors.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const reason = errors.length > 0
          ? errors.join(' ')
          : `Claude Code ended the Attempt without succeeding (${typeof message.subtype === 'string' ? message.subtype : 'unknown reason'}).`;
        emitFailure(reason);
        return;
      }
      const summary = typeof message.result === 'string' && message.result.trim().length > 0
        ? message.result.trim()
        : undefined;
      emitCompletion(summary);
    }

    function handleLine(line: string): void {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isStreamMessage(message)) return;
      switch (message.type) {
        case 'system':
          // 'init' is the one 'system' subtype that marks the runtime has
          // actually started working on the objective — every other
          // subtype (task_started, task_notification, thinking_tokens,
          // rate_limit_event's sibling notices, …) carries no shared-shape
          // equivalent and is ignored, exactly like an unrecognized Codex
          // notification.
          if (message.subtype === 'init') pushEvent({ kind: 'lifecycle', sequence: sequence++, at: now(), phase: 'turn-started' });
          return;
        case 'assistant':
          if (isStreamMessage(message.message)) handleAssistantMessage(message.message);
          return;
        case 'user':
          if (isStreamMessage(message.message)) handleUserMessage(message.message);
          return;
        case 'result':
          handleResult(message);
          return;
        default:
          // rate_limit_event and any other top-level type this build does
          // not recognize: ignored rather than fabricated into a structured
          // event.
          return;
      }
    }

    const pumpDone = (async () => {
      try {
        for await (const line of readLines(proc.stdout)) {
          handleLine(line);
          if (terminal) return;
        }
      } catch (error) {
        emitFailure(`Claude Code stream failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!terminal) {
        const exit = await proc.exited;
        emitFailure(
          `Claude Code exited before completing the Attempt${exit.code !== null ? ` (exit code ${exit.code})` : ''}`
          + `${exit.signal ? ` (signal ${exit.signal})` : ''}.`,
        );
      }
    })().finally(() => queue.close());

    // One user message, then stdin closes: this adapter runs one turn per
    // Attempt (mirroring Codex's single turn/start), never a multi-turn
    // conversation kept open over stdin.
    proc.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: buildPrompt(context) }] },
    })}\n`);
    proc.stdin.end();

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

  return { runtime: 'claude', run };
}
