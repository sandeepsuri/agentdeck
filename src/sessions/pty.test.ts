// PtyBackend tests: spawns bash directly, never the real CLIs.
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../types.js';
import { TERMINAL_COLS, TERMINAL_ROWS } from '../protocol.js';
import { PtyBackend } from './pty.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('waitFor timed out'));
      }
    }, 20);
  });
}

const spec: LaunchSpec = { agent: 'claude', cwd: '/tmp' };

describe('PtyBackend', () => {
  it('spawns at the pinned TERMINAL_COLS x TERMINAL_ROWS size — there is no per-session size hint', async () => {
    const backend = new PtyBackend({
      commandFor: () => ({ file: 'bash', args: ['-c', 'stty size; sleep 3'] }),
    });
    const handle = await backend.spawn(spec);
    cleanups.push(() => backend.kill(handle, 'SIGKILL'));

    let output = '';
    backend.onData(handle, (data) => (output += data));
    await waitFor(() => output.includes('\n'));

    // `stty size` prints "<rows> <cols>".
    expect(output.trim()).toBe(`${TERMINAL_ROWS} ${TERMINAL_COLS}`);
  });
});
