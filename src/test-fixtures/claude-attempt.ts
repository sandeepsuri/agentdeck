// A representative `claude -p --output-format stream-json` fixture (ticket
// 14 AC-equivalent of ticket 05 AC8): a scriptable fake process driven by
// the same line-delimited JSON protocol the real adapter
// (work-engine/runtimes/claude.ts) speaks, so the adapter's parsing and
// event-mapping logic runs unmodified in tests, with no real Claude Code CLI
// required.
import { PassThrough } from 'node:stream';
import type { ClaudeAttemptProcess, ClaudeProcessSpawner } from '../work-engine/runtimes/claude.js';

export type ClaudeAttemptFixtureBehavior =
  | 'success' | 'turn-failure' | 'missing-usage' | 'silent-exit'
  // The stream never plays: the process just exits (e.g. auth failure
  // before it ever prints a line).
  | 'exit-without-result';

export interface CreateFakeClaudeCliOptions {
  readonly sessionId?: string;
  readonly behavior?: ClaudeAttemptFixtureBehavior;
}

export interface FakeClaudeCli {
  readonly spawn: ClaudeProcessSpawner;
  /** Every line the adapter wrote to stdin, in order — for asserting the objective is sent and nothing else. */
  readonly writes: string[];
  /** The env each spawn() call received — for asserting the envelope's environment allowlist was actually applied. */
  readonly envs: Array<Readonly<Record<string, string>>>;
  /** The args each spawn() call received. */
  readonly argv: string[][];
}

/**
 * Builds a fake `claude -p --output-format stream-json` process. By default
 * it plays out one successful turn: a Bash command followed by a final
 * assistant message and a terminal `result` event. `behavior` selects
 * alternate scripts for the failure paths the adapter contract requires.
 */
export function createFakeClaudeCli(options: CreateFakeClaudeCliOptions = {}): FakeClaudeCli {
  const sessionId = options.sessionId ?? 'session-fixture-1';
  const behavior = options.behavior ?? 'success';
  const writes: string[] = [];
  const envs: Array<Readonly<Record<string, string>>> = [];
  const argv: string[][] = [];

  const spawn: ClaudeProcessSpawner = (_executable, args, spawnOptions) => {
    argv.push([...args]);
    envs.push(spawnOptions.env);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExited = resolve; });

    const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`); };

    const playTurn = (): void => {
      if (behavior === 'exit-without-result') {
        stdout.end();
        resolveExited({ code: 1, signal: null });
        return;
      }
      if (behavior === 'silent-exit') {
        stdout.end();
        resolveExited({ code: null, signal: null });
        return;
      }
      send({ type: 'system', subtype: 'init', cwd: '/repo', session_id: sessionId });
      send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Deciding where the test belongs' }],
        },
      });
      send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
        },
      });
      send({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: 'tool-1', content: 'ok',
            is_error: behavior === 'turn-failure',
          }],
        },
      });
      send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Added the missing test and confirmed it passes.' }],
        },
      });
      send({
        type: 'result',
        subtype: behavior === 'turn-failure' ? 'error_during_execution' : 'success',
        is_error: behavior === 'turn-failure',
        ...(behavior === 'turn-failure' ? { errors: ['The sandboxed command exited non-zero.'] } : {}),
        result: 'Added the missing test and confirmed it passes.',
        usage: behavior === 'missing-usage' ? {} : { input_tokens: 1200, output_tokens: 340 },
        session_id: sessionId,
      });
      stdout.end();
      resolveExited({ code: behavior === 'turn-failure' ? 1 : 0, signal: null });
    };

    stdin.on('data', (chunk: Buffer) => {
      writes.push(chunk.toString('utf8').trim());
      queueMicrotask(playTurn);
    });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: () => { stdout.end(); resolveExited({ code: null, signal: 'SIGTERM' }); },
    } satisfies ClaudeAttemptProcess;
  };

  return {
    spawn, writes, envs, argv,
  };
}
