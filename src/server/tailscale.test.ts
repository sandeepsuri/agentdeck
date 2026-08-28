import { describe, expect, it } from 'vitest';
import { detectTailscaleInterface, type ExecFn } from './tailscale.js';

function fakeExec(handler: (command: string, args: string[]) => { stdout: string; stderr: string }): ExecFn {
  return async (command, args) => handler(command, args);
}

describe('detectTailscaleInterface', () => {
  it('returns the IP and DNS hostname (trailing dot stripped) on success', async () => {
    const exec = fakeExec((command, args) => {
      if (args[0] === 'ip') return { stdout: '100.64.0.5\n', stderr: '' };
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({ Self: { DNSName: 'my-mac.tailnet-1234.ts.net.' } }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });
    expect(await detectTailscaleInterface(exec)).toEqual({
      ip: '100.64.0.5',
      hostname: 'my-mac.tailnet-1234.ts.net',
    });
  });

  it('degrades to undefined when the tailscale binary is missing', async () => {
    const exec: ExecFn = async () => { throw new Error('spawn tailscale ENOENT'); };
    expect(await detectTailscaleInterface(exec)).toBeUndefined();
  });

  it('degrades to undefined when not logged in / ip command fails', async () => {
    const exec: ExecFn = async (_command, args) => {
      if (args[0] === 'ip') throw new Error('tailscale is not running');
      return { stdout: '', stderr: '' };
    };
    expect(await detectTailscaleInterface(exec)).toBeUndefined();
  });

  it('degrades to undefined when the ip output is empty', async () => {
    const exec: ExecFn = async (_command, args) => args[0] === 'ip'
      ? { stdout: '   \n', stderr: '' }
      : { stdout: '{}', stderr: '' };
    expect(await detectTailscaleInterface(exec)).toBeUndefined();
  });

  it('still returns the IP when status --json is malformed (hostname best-effort only)', async () => {
    const exec: ExecFn = async (_command, args) => args[0] === 'ip'
      ? { stdout: '100.64.0.5\n', stderr: '' }
      : { stdout: 'not json', stderr: '' };
    expect(await detectTailscaleInterface(exec)).toEqual({ ip: '100.64.0.5', hostname: undefined });
  });

  it('still returns the IP when status --json has no Self.DNSName', async () => {
    const exec: ExecFn = async (_command, args) => args[0] === 'ip'
      ? { stdout: '100.64.0.5\n', stderr: '' }
      : { stdout: JSON.stringify({ Self: {} }), stderr: '' };
    expect(await detectTailscaleInterface(exec)).toEqual({ ip: '100.64.0.5', hostname: undefined });
  });

  it('degrades to undefined on a timeout (exec rejects)', async () => {
    const exec: ExecFn = async (_command, args) => {
      if (args[0] === 'ip') {
        const error = new Error('timed out');
        (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
        throw error;
      }
      return { stdout: '', stderr: '' };
    };
    expect(await detectTailscaleInterface(exec)).toBeUndefined();
  });

  it('passes a short timeout through to the injected exec function', async () => {
    let seenTimeout: number | undefined;
    const exec: ExecFn = async (_command, _args, opts) => {
      seenTimeout = opts.timeout;
      return { stdout: '100.64.0.5\n', stderr: '' };
    };
    await detectTailscaleInterface(exec);
    expect(seenTimeout).toBeLessThanOrEqual(5000);
    expect(seenTimeout).toBeGreaterThan(0);
  });
});
