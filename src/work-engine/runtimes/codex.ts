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
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { resolveAgentExecutable } from '../../sessions/executable.js';
import { filterEnvironment } from '../envelope.js';
import type { AttentionDecisionInput, AttemptEvent, AttentionRequestKind } from '../types.js';
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

// Ticket 07: Codex's own JSON-RPC schema names the approval request/response
// pair 'CommandExecutionRequestApprovalParams'/'...Response' (see
// sessions/runtime-readiness.ts's generateCodexProtocolEvidence, which only
// confirms those schema files exist — not the exact method name or response
// field a real `codex app-server` sends, which this repo has no fixture or
// doc pinning). Every other method name this adapter already relies on
// follows one consistent PascalCase-schema → 'namespace/verb' convention
// ('ThreadStartParams' → 'thread/start', 'ThreadTokenUsageUpdatedNotification'
// → 'thread/tokenUsageUpdated'), so 'commandExecution/requestApproval' is
// the same convention applied to that schema name — a reasoned inference,
// not a verified fact. Classification below only ever keys off whether
// "approval" appears in the method name at all, so it still recognizes a
// close variant if the real name differs in namespace or verb casing; an
// unrecognized server-to-client request that doesn't mention approval is
// treated as a plain input request instead of failing closed.
function classifyAttentionRequest(method: string): AttentionRequestKind {
  return /approval/i.test(method) ? 'approval' : 'input';
}

/** Tries the field names a genuine clarifying question is most likely to arrive under, before giving up on a specific answer. */
function questionText(params: Record<string, unknown>): string | undefined {
  for (const key of ['question', 'prompt', 'message', 'text']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// Ticket 07 AC1: a human-readable reason describes what's actually being
// asked, never the wire protocol that carried it — the raw JSON-RPC method
// name (e.g. 'thread/requestClarification') is an implementation detail an
// operator approving/denying a request has no reason to see.
function describeAttentionRequest(kind: AttentionRequestKind, params: Record<string, unknown>): string {
  if (kind === 'approval') {
    const command = itemSummary(params);
    return command ? `Codex is requesting approval to run: ${command}` : 'Codex is requesting approval before it can continue.';
  }
  return questionText(params) ?? 'Codex is requesting input before it can continue.';
}

/** The reply shape is exactly as unverified as the request's own method name (see classifyAttentionRequest) — self-consistent with this adapter's own request/response pairing, not asserted as Codex's real wire contract. */
function buildAttentionResponseResult(kind: AttentionRequestKind, decision: AttentionDecisionInput): Record<string, unknown> {
  if (kind === 'approval') return { decision: decision.kind === 'approve' ? 'approved' : 'denied' };
  return { value: decision.kind === 'input' ? decision.value : '' };
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

    // Ticket 07: a server-to-client request (approval or input) becomes a
    // durable, human-readable attention-requested event and awaits the
    // engine's one policy path (context.awaitAttentionDecision) for a
    // decision, then relays exactly that decision back to Codex — never
    // anything more (AC5: nothing here can touch the frozen Repository,
    // revision, Profile, runtime, budget, workspace, policy, or secret
    // grants, since none of those are reachable from this function at all).
    // No callback means no engine is wired to a policy path for this run
    // (e.g. a bare adapter-contract test) — preserve the old safe-decline
    // behavior rather than hang the turn forever waiting on nothing.
    async function handleAttentionRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
      if (terminal) return;
      if (!context.awaitAttentionDecision) {
        proc.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id, error: { code: -32601, message: 'Managed Attempts do not support interactive approvals yet.' },
        })}\n`);
        return;
      }
      const attentionKind = classifyAttentionRequest(method);
      // Ticket 07 AC1's "stable correlation": deterministic from
      // (context.runId, this JSON-RPC request's own id) — Codex assigns
      // that id, unique among this connection's outstanding requests, so
      // hashing it (rather than minting a fresh random id per call) means
      // a genuinely redelivered identical request reproduces the exact
      // same attentionId and durable event, deduplicated by dedupeKey
      // (durable-events.ts) the same way every other AttemptEvent already
      // is — never a second, orphaned pending request.
      const attentionId = createHash('sha256').update(`${context.runId}:${id}`).digest('hex');
      pushEvent({
        kind: 'attention-requested', sequence: sequence++, at: now(), attentionId, attentionKind,
        reason: describeAttentionRequest(attentionKind, params),
      });
      const decision = await context.awaitAttentionDecision(attentionId);
      if (terminal) return;
      proc.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, result: buildAttentionResponseResult(attentionKind, decision),
      })}\n`);
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
        void handleAttentionRequest(message.id, message.method, message.params ?? {});
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
        // Ticket 07: now that a real policy path exists to resolve one
        // (handleAttentionRequest above), Codex is allowed to actually ask
        // rather than being told never to. 'on-request' still leaves the
        // decision of *whether* to ask to Codex itself; AgentDeck's own
        // capability envelope (envelope.ts) is what already bounds what an
        // approved command could do regardless of this policy.
        approvalPolicy: 'on-request',
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
