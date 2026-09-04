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
//
// Ticket 07/14 AC2: `--permission-mode acceptEdits` plus
// `--permission-prompts host --permission-prompt-tool stdio` is the Claude
// equivalent of the stance codex.ts already takes (sandbox
// 'workspace-write' with approvalPolicy 'on-request'): edits inside the
// prepared worktree proceed without asking, and everything the CLI would
// otherwise prompt a human about becomes a durable Run attention resolved
// through the engine's one policy path. Two facts about that channel were
// captured from a real installed Claude Code (2.1.260), not guessed:
//   - it only asks when `--permission-prompt-tool stdio` is passed. Without
//     it the CLI auto-denies and emits a 'system'/'permission_denied'
//     notice instead of ever consulting the host. That flag is not listed
//     in `--help`, so ticket 01's readiness probe cannot look for it
//     directly; the 'approvals' capability it does gate on (Claude Code
//     >= 2.1.208 with `--permission-mode` and stream-json input) is the
//     stand-in. An installation old enough to reject the flag exits
//     immediately, which this adapter already reports as a precise Attempt
//     failure rather than a hang or a silent bypass.
//   - stdin must stay open for the whole turn. The control channel is
//     bidirectional over the same pipe that carried the objective; closing
//     it after writing the objective fails every pending request with
//     "Tool permission request failed: AbortError: Stream closed".
//
// Provider conversation identity (the Claude session_id) lives only in this
// module's closures — it is never put on an AttemptEvent, never reaches
// WorkRun/Store (ticket 05 AC3/AC4, extended to Claude by ticket 14).
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  /** The provider conversation id a Run's first round opens under — injectable so tests can assert continuation deterministically. */
  newSessionId?: () => string;
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

/** The identifying detail of a tool_use block's input, by the field the tool actually carries it under. Raw fact for the durable log — wording is attempt-narrative.ts's job. */
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

/**
 * A resumed round is talking to a conversation that already holds the
 * Attempt's acceptance criteria, so it carries only its own new instruction
 * (ticket 08's repair objective) — restating the frozen criteria every
 * round is exactly the objective replay ticket 14 AC4 rules out.
 */
function buildPrompt(context: AttemptLaunchContext, resumed: boolean): string {
  if (resumed) return context.objective;
  const criteria = context.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  return `${context.objective}\n\nAcceptance criteria:\n${criteria}`;
}

// Ticket 07 AC1: the reason describes what is actually being asked, never
// the wire protocol that carried it — a `can_use_tool` control request's
// own id and subtype are implementation detail an operator deciding on it
// has no reason to see.
function describePermissionRequest(request: Record<string, unknown>): string {
  const tool = typeof request.tool_name === 'string' ? request.tool_name : 'a tool';
  const summary = toolSummary(request.input)
    ?? (typeof request.description === 'string' && request.description.trim().length > 0
      ? request.description.trim()
      : undefined);
  return summary
    ? `Claude is requesting approval to use ${tool}: ${summary}`
    : `Claude is requesting approval to use ${tool} before it can continue.`;
}

export function createClaudeAttemptAdapter(
  options: CreateClaudeAttemptAdapterOptions = {},
): RuntimeAttemptAdapter {
  const resolveExecutable = options.resolveExecutable ?? (() => resolveAgentExecutable('claude'));
  const spawnProcess = options.spawn ?? defaultSpawn;
  const nowFn = options.now ?? (() => new Date());
  const newSessionId = options.newSessionId ?? (() => randomUUID());
  // Ticket 14 AC2/AC3: the provider conversation each Run is talking to,
  // held only here — in this adapter instance's own closure, never
  // persisted, never on an AttemptEvent, never any part of AgentDeck's Run
  // identity. Keyed by Run because a Run has exactly one Attempt (start()
  // refuses a second), so this is per-Attempt in practice; it is what lets
  // ticket 08's repair rounds continue the conversation that already did
  // the work instead of re-deriving it from scratch.
  const providerSessions = new Map<string, string>();

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
    const priorSession = providerSessions.get(context.runId);
    const sessionId = priorSession ?? newSessionId();
    providerSessions.set(context.runId, sessionId);
    const proc = spawnProcess(executable, [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'host',
      '--permission-prompt-tool', 'stdio',
      '--setting-sources', '',
      '--strict-mcp-config',
      // A later round of the same Run continues the conversation it already
      // opened rather than opening a second one; `--resume` keeps the same
      // session id (verified against a real CLI) so this stays one provider
      // conversation for the whole Attempt.
      ...(priorSession ? ['--resume', sessionId] : ['--session-id', sessionId]),
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

    // Never writes to a stdin the round has already closed: a control
    // request can still be sitting in the pump's buffer when the terminal
    // event ends the round and the generator's `finally` ends stdin, and
    // an ERR_STREAM_WRITE_AFTER_END on a stream nothing is listening to
    // would take the process down rather than fail this one reply.
    const writeControlResponse = (requestId: string, envelope: Record<string, unknown>): void => {
      if (proc.stdin.writableEnded || proc.stdin.destroyed) return;
      proc.stdin.write(`${JSON.stringify({ type: 'control_response', response: { ...envelope, request_id: requestId } })}\n`);
    };

    /**
     * Ticket 07/14 AC2: a `can_use_tool` control request becomes a durable,
     * human-readable attention-requested event and awaits the engine's one
     * policy path (context.awaitAttentionDecision) for a decision, then
     * relays exactly that decision back to Claude — never anything more
     * (ticket 07 AC5: nothing here can touch the frozen Repository,
     * revision, Profile, runtime, budget, workspace, policy, or secret
     * grants, since none of those are reachable from this function at all).
     *
     * `can_use_tool` is the only request subtype this managed invocation can
     * receive: hook callbacks and SDK-MCP messages are the other two the
     * protocol defines, and neither is reachable without registering hooks
     * or an SDK MCP server, which `--setting-sources ''` and
     * `--strict-mcp-config` already rule out. Every request Claude makes is
     * therefore an approval; AgentDeck does not fabricate an 'input' kind
     * for a channel that has no way to ask for one. Anything unrecognized
     * is still answered — an unanswered control request stalls the CLI's
     * turn indefinitely — with the error envelope the protocol's own
     * success envelope implies, rather than a decision nobody made.
     */
    async function handleControlRequest(message: Record<string, unknown>): Promise<void> {
      const requestId = message.request_id;
      const request = message.request;
      if (typeof requestId !== 'string' || terminal) return;
      if (!isStreamMessage(request) || request.subtype !== 'can_use_tool') {
        writeControlResponse(requestId, { subtype: 'error', error: 'AgentDeck only answers can_use_tool requests.' });
        return;
      }
      // No callback means no engine is wired to a policy path for this Run
      // (e.g. a bare adapter-contract test) — decline safely rather than
      // hang the turn forever waiting on nothing, exactly as codex.ts does.
      if (!context.awaitAttentionDecision) {
        writeControlResponse(requestId, {
          subtype: 'error', error: 'Managed Attempts have no operator wired to answer this request.',
        });
        return;
      }
      // Ticket 07 AC1's "stable correlation": deterministic from
      // (context.runId, Claude's own control request id), which is unique
      // among this process's outstanding requests — so a genuinely
      // redelivered identical request reproduces the exact same attentionId
      // and durable event, deduplicated by dedupeKey (durable-events.ts)
      // the same way every other AttemptEvent already is. Hashing also
      // keeps the provider's id off the event (AC3).
      const attentionId = createHash('sha256').update(`${context.runId}:${requestId}`).digest('hex');
      pushEvent({
        kind: 'attention-requested', sequence: sequence++, at: now(), attentionId, attentionKind: 'approval',
        reason: describePermissionRequest(request),
      });
      const decision = await context.awaitAttentionDecision(attentionId);
      if (terminal) return;
      writeControlResponse(requestId, {
        subtype: 'success',
        response: decision.kind === 'approve'
          // `updatedInput` is how the protocol carries the input the tool
          // should actually run with: relaying Claude's own input back
          // unchanged approves exactly what the operator was shown, and
          // nothing else.
          ? { behavior: 'allow', updatedInput: request.input ?? {} }
          : { behavior: 'deny', message: 'The AgentDeck operator denied this action.' },
      });
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
        case 'control_request':
          void handleControlRequest(message);
          return;
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

    // One user message per round (mirroring Codex's single turn/start),
    // never a multi-turn conversation driven from stdin. stdin itself stays
    // open until the round is over, though: it is also the return half of
    // the permission control channel (see this module's header comment).
    proc.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: buildPrompt(context, priorSession !== undefined) }] },
    })}\n`);

    try {
      for await (const event of queue) {
        yield event;
        if (event.kind === 'completion' || event.kind === 'failure') break;
      }
    } finally {
      proc.stdin.end();
      proc.kill();
      await pumpDone.catch(() => undefined);
    }
  }

  return { runtime: 'claude', run };
}
