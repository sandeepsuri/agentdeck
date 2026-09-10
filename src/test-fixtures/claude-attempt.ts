// A representative `claude -p --output-format stream-json` fixture (ticket
// 14 AC-equivalent of ticket 05 AC8): a scriptable fake process driven by
// the same line-delimited JSON protocol the real adapter
// (work-engine/runtimes/claude.ts) speaks, so the adapter's parsing and
// event-mapping logic runs unmodified in tests, with no real Claude Code CLI
// required.
//
// The 'permission-request' script below reproduces the control channel
// exactly as a real installed Claude Code (2.1.260) drives it — request and
// response shapes captured from that CLI, not guessed:
//   CLI  → {"type":"control_request","request_id":"<uuid>","request":{
//            "subtype":"can_use_tool","tool_name":"Write","display_name":…,
//            "input":{…},"description":"probe-note.txt",
//            "permission_suggestions":[…],"tool_use_id":"toolu_…"}}
//   host → {"type":"control_response","response":{"subtype":"success",
//            "request_id":"<uuid>","response":{"behavior":"deny",
//            "message":"…"}}}
// A denial's `message` comes back to the model as that tool_use's own
// is_error tool_result, which is what the denial branch below replays.
import { PassThrough } from 'node:stream';
import type { ClaudeAttemptProcess, ClaudeProcessSpawner } from '../work-engine/runtimes/claude.js';

export type ClaudeAttemptFixtureBehavior =
  | 'success' | 'turn-failure' | 'missing-usage' | 'silent-exit'
  // The stream never plays: the process just exits (e.g. auth failure
  // before it ever prints a line).
  | 'exit-without-result'
  // Ticket 14 AC2: the CLI asks the host for permission over the control
  // channel and will not proceed until it is answered.
  | 'permission-request';

export interface CreateFakeClaudeCliOptions {
  readonly sessionId?: string;
  readonly behavior?: ClaudeAttemptFixtureBehavior;
  /** Only used when behavior is 'permission-request' — the control request id the CLI asks under. */
  readonly permissionRequestId?: string;
  /** Only used when behavior is 'permission-request' — overrides the `request` body the CLI sends. */
  readonly permissionRequest?: Record<string, unknown>;
}

export interface FakeClaudeCli {
  readonly spawn: ClaudeProcessSpawner;
  /** Every line the adapter wrote to stdin, in order — for asserting the objective is sent and nothing else. */
  readonly writes: string[];
  /** The env each spawn() call received — for asserting the envelope's environment allowlist was actually applied. */
  readonly envs: Array<Readonly<Record<string, string>>>;
  /** The args each spawn() call received. */
  readonly argv: string[][];
  /** Populated only when behavior is 'permission-request': the exact `response` payload the adapter replied with, once received. */
  readonly controlResponses: Array<Record<string, unknown>>;
  /** Whether the adapter closed stdin, per spawn — the control channel only works while it stays open. */
  readonly stdinEndedDuringTurn: boolean[];
}

const DEFAULT_PERMISSION_REQUEST_ID = 'perm-request-1';

/**
 * Builds a fake `claude -p --output-format stream-json` process. By default
 * it plays out one successful turn: a Bash command followed by a final
 * assistant message and a terminal `result` event. `behavior` selects
 * alternate scripts for the failure and approval paths the adapter contract
 * requires.
 */
export function createFakeClaudeCli(options: CreateFakeClaudeCliOptions = {}): FakeClaudeCli {
  const sessionId = options.sessionId ?? 'session-fixture-1';
  const behavior = options.behavior ?? 'success';
  const permissionRequestId = options.permissionRequestId ?? DEFAULT_PERMISSION_REQUEST_ID;
  const writes: string[] = [];
  const envs: Array<Readonly<Record<string, string>>> = [];
  const argv: string[][] = [];
  const controlResponses: Array<Record<string, unknown>> = [];
  const stdinEndedDuringTurn: boolean[] = [];

  const spawn: ClaudeProcessSpawner = (_executable, args, spawnOptions) => {
    const spawnIndex = argv.length;
    argv.push([...args]);
    envs.push(spawnOptions.env);
    stdinEndedDuringTurn.push(false);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let turnSettled = false;
    let resolveExited: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExited = resolve; });

    const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`); };

    const finish = (): void => {
      turnSettled = true;
      stdout.end();
      resolveExited({ code: behavior === 'turn-failure' ? 1 : 0, signal: null });
    };

    const sendResult = (extra: Record<string, unknown> = {}): void => {
      send({
        type: 'result',
        subtype: behavior === 'turn-failure' ? 'error_during_execution' : 'success',
        is_error: behavior === 'turn-failure',
        ...(behavior === 'turn-failure' ? { errors: ['The sandboxed command exited non-zero.'] } : {}),
        result: 'Added the missing test and confirmed it passes.',
        usage: behavior === 'missing-usage' ? {} : { input_tokens: 1200, output_tokens: 340 },
        session_id: sessionId,
        ...extra,
      });
    };

    const playTurn = (): void => {
      if (behavior === 'exit-without-result') {
        turnSettled = true;
        stdout.end();
        resolveExited({ code: 1, signal: null });
        return;
      }
      if (behavior === 'silent-exit') {
        turnSettled = true;
        stdout.end();
        resolveExited({ code: null, signal: null });
        return;
      }
      send({ type: 'system', subtype: 'init', cwd: '/repo', session_id: sessionId });
      if (behavior === 'permission-request') {
        // The CLI stops here: nothing else is emitted until the host answers
        // on stdin (see the control_response branch of the stdin reader).
        send({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-perm-1', name: 'Bash', input: { command: 'rm -rf node_modules' } }],
          },
        });
        send({
          type: 'control_request',
          request_id: permissionRequestId,
          request: options.permissionRequest ?? {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            display_name: 'Bash',
            input: { command: 'rm -rf node_modules', description: 'Clear installed packages' },
            description: 'Clear installed packages',
            permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            tool_use_id: 'tool-perm-1',
          },
        });
        return;
      }
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
      sendResult();
      finish();
    };

    // A real CLI turns the host's decision into that tool_use's own
    // tool_result — an ordinary one when allowed, an is_error one carrying
    // the denial message when denied — and then finishes the turn.
    const resumeAfterPermissionDecision = (response: Record<string, unknown>): void => {
      const denied = response.behavior === 'deny';
      send({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-perm-1',
            content: denied ? String(response.message ?? 'Permission denied.') : 'ok',
            is_error: denied,
          }],
        },
      });
      send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: denied ? 'The operator denied that action.' : 'Cleared the installed packages.' }],
        },
      });
      sendResult({ result: denied ? 'The operator denied that action.' : 'Cleared the installed packages.' });
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
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type === 'user') {
          queueMicrotask(playTurn);
        } else if (message.type === 'control_response') {
          const envelope = (message.response ?? {}) as Record<string, unknown>;
          if (envelope.request_id !== permissionRequestId) continue;
          const response = (envelope.response ?? {}) as Record<string, unknown>;
          // Only a 'success' envelope carries an operator decision; an
          // 'error' envelope is the adapter's own safe-decline fallback
          // (no policy path wired) and unblocks the turn as a denial.
          if (envelope.subtype === 'success') controlResponses.push(response);
          resumeAfterPermissionDecision(
            envelope.subtype === 'success' ? response : { behavior: 'deny', message: 'No host answered the permission request.' },
          );
        }
      }
    });
    stdin.on('end', () => { if (!turnSettled) stdinEndedDuringTurn[spawnIndex] = true; });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: () => { stdout.end(); resolveExited({ code: null, signal: 'SIGTERM' }); },
    } satisfies ClaudeAttemptProcess;
  };

  return {
    spawn, writes, envs, argv, controlResponses, stdinEndedDuringTurn,
  };
}
