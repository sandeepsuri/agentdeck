// Issue #91: runs the native window-capture helper (native/AgentDeckNotch,
// target AgentDeckWindowView). The helper uses ScreenCaptureKit to capture
// exactly one window by id, shows its own on-screen indicator with a Stop
// button for as long as it runs, and writes JPEG frames to stdout:
//
//   u32 BE jpeg length | u16 BE width | u16 BE height | jpeg bytes
//
// It exits when its stdin closes, so a service that stops or crashes never
// leaves a capture (or its indicator) behind.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureDriver, CaptureEnd, CapturedFrame, ScreenPermission, ShareableWindow } from '../window-view/service.js';
import { UNSUPPORTED_HELP, WindowViewError } from '../window-view/service.js';

/** No frame the helper sends is larger than this; anything bigger is a broken stream. */
export const MAX_HELPER_FRAME_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 8;
const COMMAND_TIMEOUT_MS = 15_000;
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** Helper exit codes; see main.swift in AgentDeckWindowView. */
const EXIT_PERMISSION = 3;
const EXIT_WINDOW_GONE = 4;
const EXIT_STOPPED_AT_MAC = 5;

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (frame: CapturedFrame) => void) {}

  push(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (this.buffered.length >= HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_HELPER_FRAME_BYTES) throw new Error('The capture helper sent a frame that is too large.');
      if (this.buffered.length < HEADER_BYTES + length) return;
      const width = this.buffered.readUInt16BE(4);
      const height = this.buffered.readUInt16BE(6);
      const jpeg = Buffer.from(this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length));
      this.buffered = this.buffered.subarray(HEADER_BYTES + length);
      this.onFrame({ jpeg, width, height });
    }
  }
}

/** The helper's window list, keeping only well-formed entries. */
export function parseWindowList(text: string): ShareableWindow[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const { id, app, title } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || typeof app !== 'string' || !app || typeof title !== 'string') return [];
    return [{ id, app: app.slice(0, 120), title: title.slice(0, 200) }];
  });
}

/** Where the helper is: beside the compiled companion, or in dist/native when running from source. */
export function windowCaptureExecutable(): string | undefined {
  const bundle = path.join('AgentDeckWindowView.app', 'Contents', 'MacOS', 'AgentDeckWindowView');
  const candidates = [
    process.env.AGENTDECK_WINDOW_VIEW_HELPER,
    path.join(import.meta.dirname, bundle),
    path.resolve(import.meta.dirname, '../../dist/native', bundle),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate) && fs.existsSync(candidate!));
}

function run(executable: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

function asPermission(stdout: string): ScreenPermission {
  return stdout.trim() === 'granted' ? 'granted' : 'denied';
}

export function nativeCaptureDriver(executable = windowCaptureExecutable()): CaptureDriver & { openSettings(): Promise<void> } {
  const supported = process.platform === 'darwin' && Boolean(executable);
  return {
    // A fresh process each time, so a permission change shows up at once.
    permission: async () => (supported ? asPermission((await run(executable!, ['permission'])).stdout) : 'unsupported'),
    requestPermission: async () => (supported ? asPermission((await run(executable!, ['request-permission'])).stdout) : 'unsupported'),
    listWindows: async () => {
      if (!supported) throw new WindowViewError('unsupported', UNSUPPORTED_HELP);
      const result = await run(executable!, ['list']);
      if (result.code === EXIT_PERMISSION) throw new WindowViewError('permission-denied', 'Screen Recording permission is off for AgentDeck.');
      if (result.code !== 0) throw new Error('The capture helper could not list windows.');
      return parseWindowList(result.stdout);
    },
    openSettings: () => new Promise((resolve) => {
      execFile('/usr/bin/open', [SETTINGS_URL], () => resolve());
    }),
    capture: (window, events) => {
      if (!supported) {
        events.onEnd('failed');
        return { stop: () => undefined };
      }
      let stopping = false;
      let finished = false;
      const child = spawn(executable!, ['capture', String(window.id)], { stdio: ['pipe', 'pipe', 'ignore'] });
      const finish = (reason: CaptureEnd) => {
        if (finished) return;
        finished = true;
        if (!stopping) events.onEnd(reason);
      };
      const decoder = new FrameDecoder((frame) => { if (!stopping) events.onFrame(frame); });
      child.stdout.on('data', (chunk: Buffer) => {
        try { decoder.push(chunk); } catch { child.kill('SIGKILL'); finish('failed'); }
      });
      child.stdin.on('error', () => undefined);
      child.on('error', () => finish('failed'));
      child.on('exit', (code) => {
        finish(code === EXIT_PERMISSION ? 'permission-denied'
          : code === EXIT_WINDOW_GONE ? 'window-closed'
            : code === EXIT_STOPPED_AT_MAC ? 'stopped-at-mac'
              : 'failed');
      });
      return {
        stop: () => {
          if (stopping) return;
          stopping = true;
          // Closing stdin ends the helper; the signals are for one that does not listen.
          child.stdin.end();
          const term = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 300);
          const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_500);
          term.unref();
          force.unref();
        },
      };
    },
  };
}
