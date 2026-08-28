// WakeLock (T6): holds a `caffeinate` assertion while any managed session
// is live. spawn is injected so these tests never touch a real process —
// same pattern as SessionManager's fake SessionBackend.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { WakeLock } from './wake-lock.js';

function makeFakeChild(): ChildProcess {
  return {
    exitCode: null,
    killed: false,
    kill: vi.fn(),
    on: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

describe('WakeLock', () => {
  it('spawns caffeinate exactly once when the live count goes 0->positive', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(1);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('caffeinate', ['-i', '-s', '-u'], expect.anything());
  });

  it('does not spawn again while the count stays positive across further updates', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(1);
    wakeLock.update(2);
    wakeLock.update(3);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('kills the held process when the count drops back to 0', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(1);
    wakeLock.update(0);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('update(0) is a no-op when no assertion was ever held', () => {
    const spawn = vi.fn();
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(0);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('release() kills an active process', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(1);
    wakeLock.release();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('release() is a no-op when nothing is held', () => {
    const spawn = vi.fn();
    const wakeLock = new WakeLock({ spawn });

    expect(() => wakeLock.release()).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a subsequent update(1) after release() spawns a fresh process', () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const wakeLock = new WakeLock({ spawn });

    wakeLock.update(1);
    wakeLock.update(0);
    wakeLock.update(1);

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('never spawns on a non-darwin platform', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const child = makeFakeChild();
      const spawn = vi.fn().mockReturnValue(child);
      const wakeLock = new WakeLock({ spawn });

      wakeLock.update(1);
      wakeLock.release();

      expect(spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
