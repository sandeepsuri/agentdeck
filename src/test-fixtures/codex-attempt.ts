// A representative `codex app-server` fixture (ticket 05 AC8): a scriptable
// fake process driven by the same JSON-RPC-over-stdio protocol the real
// adapter (work-engine/runtimes/codex.ts) speaks, so the adapter's parsing
// and event-mapping logic runs unmodified in tests, with no real Codex CLI
// required.
import { PassThrough } from 'node:stream';
import type { CodexAttemptProcess, CodexProcessSpawner } from '../work-engine/runtimes/codex.js';

export type CodexAttemptFixtureBehavior =
  | 'success' | 'turn-failure' | 'handshake-failure' | 'missing-usage' | 'silent-exit' | 'attention-request'
  // An app-server that rejects the objective-carrying request itself and
  // then stays alive and silent — never a notification, never an exit — so
  // the only thing that can end the Attempt is the rejection.
  | 'objective-start-unsupported';

/** Only used when behavior is 'attention-request' — the JSON-RPC id this fixture sends its one server-to-client request under. */
export const ATTENTION_REQUEST_ID = 9001;

export interface CreateFakeCodexAppServerOptions {
  readonly threadId?: string;
  readonly behavior?: CodexAttemptFixtureBehavior;
  /** Only used when behavior is 'attention-request': the JSON-RPC method name Codex "asks" with — defaults to the approval-shaped name the adapter itself infers its method name convention from. */
  readonly attentionMethod?: string;
  readonly attentionParams?: Record<string, unknown>;
}

export interface FakeCodexAppServer {
  readonly spawn: CodexProcessSpawner;
  /** Every line the adapter wrote to stdin, in order — for asserting on outgoing requests (e.g. no leaked secrets). */
  readonly writes: string[];
  /** The env each spawn() call received — for asserting the envelope's environment allowlist was actually applied. */
  readonly envs: Array<Readonly<Record<string, string>>>;
  /** Populated only when behavior is 'attention-request': the exact JSON-RPC `result` the adapter replied with, once received. */
  readonly attentionResponses: Array<Record<string, unknown>>;
}

/**
 * Builds a fake `codex app-server` process. By default it plays out one
 * successful turn: a sandboxed command execution followed by a final
 * assistant message and a token-usage notification. `behavior` selects
 * alternate scripts for the failure paths the adapter contract requires.
 */
export function createFakeCodexAppServer(options: CreateFakeCodexAppServerOptions = {}): FakeCodexAppServer {
  const threadId = options.threadId ?? 'thread-fixture-1';
  const behavior = options.behavior ?? 'success';
  const writes: string[] = [];
  const envs: Array<Readonly<Record<string, string>>> = [];
  const attentionResponses: Array<Record<string, unknown>> = [];

  const spawn: CodexProcessSpawner = (_executable, _args, spawnOptions) => {
    envs.push(spawnOptions.env);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExited = resolve; });

    let turnStartRequestId: number | undefined;
    const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`); };
    // The real app-server answers 'turn/start' only once the turn is over —
    // its TurnStartResponse carries completedAt/durationMs/error — so this
    // fixture answers it here, after the notification stream has played out.
    const finish = (): void => {
      if (turnStartRequestId !== undefined) {
        send({ jsonrpc: '2.0', id: turnStartRequestId, result: { turn: { id: 'turn-fixture-1', items: [], status: 'completed' } } });
      }
      stdout.end();
      resolveExited({ code: 0, signal: null });
    };

    const playTurn = (): void => {
      if (behavior === 'silent-exit') { finish(); return; }
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId } });
      if (behavior === 'attention-request') {
        // A server-to-client request instead of the normal script — the
        // adapter must reply on stdin (see the stdin handler's
        // ATTENTION_REQUEST_ID branch below) before this fixture continues.
        send({
          jsonrpc: '2.0',
          id: ATTENTION_REQUEST_ID,
          method: options.attentionMethod ?? 'commandExecution/requestApproval',
          params: options.attentionParams ?? { threadId, command: 'rm -rf node_modules' },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { threadId, item: { id: 'item-1', type: 'command_execution', command: 'npm test' } },
      });
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { threadId, item: { id: 'item-1', type: 'command_execution', command: 'npm test', status: 'completed' } },
      });
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { threadId, item: { id: 'item-2', type: 'agent_message', text: 'Added the missing test and confirmed it passes.' } },
      });
      send({
        jsonrpc: '2.0',
        method: 'thread/tokenUsageUpdated',
        params: behavior === 'missing-usage' ? { threadId } : { threadId, inputTokens: 1200, outputTokens: 340 },
      });
      if (behavior === 'turn-failure') {
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, error: { message: 'The sandboxed command exited non-zero.' } } });
      } else {
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId } });
      }
      finish();
    };

    const resumeAfterAttentionResolved = (): void => {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { threadId, item: { id: 'item-2', type: 'agent_message', text: 'Continued after the pending attention request was resolved.' } },
      });
      send({ jsonrpc: '2.0', method: 'thread/tokenUsageUpdated', params: { threadId, inputTokens: 500, outputTokens: 120 } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId } });
      finish();
    };

    let buffer = '';
    stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        writes.push(line);
        const message = JSON.parse(line) as {
          id?: number; method?: string; result?: Record<string, unknown>; error?: { code?: number; message?: string };
        };
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: {} });
        } else if (message.method === 'thread/start') {
          if (behavior === 'handshake-failure') {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'sandbox unavailable in this environment' } });
          } else {
            send({ jsonrpc: '2.0', id: message.id, result: { threadId } });
          }
        } else if (message.method === 'turn/start') {
          if (behavior === 'objective-start-unsupported') {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: turn/start' } });
          } else {
            turnStartRequestId = message.id;
            queueMicrotask(playTurn);
          }
        } else if (message.id === ATTENTION_REQUEST_ID && (message.result !== undefined || message.error !== undefined)) {
          // Either a real decision (result) or the adapter's own safe-decline
          // fallback (error, when no policy path was wired) — both unblock
          // this fixture's turn identically; only `result` replies are
          // recorded, since a JSON-RPC error carries no operator decision.
          if (message.result !== undefined) attentionResponses.push(message.result);
          resumeAfterAttentionResolved();
        }
      }
    });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: () => { stdout.end(); resolveExited({ code: null, signal: 'SIGTERM' }); },
    } satisfies CodexAttemptProcess;
  };

  return {
    spawn, writes, envs, attentionResponses,
  };
}
