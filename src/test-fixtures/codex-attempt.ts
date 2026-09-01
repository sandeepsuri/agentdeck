// A representative `codex app-server` fixture (ticket 05 AC8): a scriptable
// fake process driven by the same JSON-RPC-over-stdio protocol the real
// adapter (work-engine/runtimes/codex.ts) speaks, so the adapter's parsing
// and event-mapping logic runs unmodified in tests, with no real Codex CLI
// required.
import { PassThrough } from 'node:stream';
import type { CodexAttemptProcess, CodexProcessSpawner } from '../work-engine/runtimes/codex.js';

export type CodexAttemptFixtureBehavior = 'success' | 'turn-failure' | 'handshake-failure' | 'missing-usage' | 'silent-exit';

export interface CreateFakeCodexAppServerOptions {
  readonly threadId?: string;
  readonly behavior?: CodexAttemptFixtureBehavior;
}

export interface FakeCodexAppServer {
  readonly spawn: CodexProcessSpawner;
  /** Every line the adapter wrote to stdin, in order — for asserting on outgoing requests (e.g. no leaked secrets). */
  readonly writes: string[];
  /** The env each spawn() call received — for asserting the envelope's environment allowlist was actually applied. */
  readonly envs: Array<Readonly<Record<string, string>>>;
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

  const spawn: CodexProcessSpawner = (_executable, _args, spawnOptions) => {
    envs.push(spawnOptions.env);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExited = resolve; });

    const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`); };
    const finish = (): void => { stdout.end(); resolveExited({ code: 0, signal: null }); };

    const playTurn = (): void => {
      if (behavior === 'silent-exit') { finish(); return; }
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId } });
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
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: {} });
        } else if (message.method === 'thread/start') {
          if (behavior === 'handshake-failure') {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'sandbox unavailable in this environment' } });
          } else {
            send({ jsonrpc: '2.0', id: message.id, result: { threadId } });
          }
        } else if (message.method === 'thread/sendMessage') {
          queueMicrotask(playTurn);
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

  return { spawn, writes, envs };
}
