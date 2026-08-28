import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface WakeLockOptions {
  spawn?: typeof nodeSpawn;
}

/**
 * Holds a `caffeinate -i -s -u` assertion (idle-sleep + system-sleep +
 * user-active) for as long as at least one managed session is live, and
 * releases it the moment the count drops back to zero. Mirrors
 * native/companion.ts's shape: darwin-only guard, spawn() + .unref(), and a
 * teardown that kills the child only if it's still running.
 *
 * Limitation — do not paper over this: `caffeinate -i -s -u` reliably
 * blocks idle sleep and full system sleep, and its `-u` flag resets the
 * display-sleep timer, but none of that reaches macOS clamshell
 * (lid-closed) sleep. Lid-closed sleep is a separate, largely
 * hardware/firmware-gated mechanism — software can override it at all only
 * when the Mac is on AC power *and* has an external display attached or is
 * docked. On battery, or with no external display, closing the lid sleeps
 * the machine regardless of any assertion held here. So ticket 06's third
 * acceptance line ("closing the lid ... leaves the workspace reachable
 * remotely") is not something this module can guarantee by itself — this
 * is a best-effort assertion, correct within caffeinate's actual scope,
 * and the lid-closed case depends on hardware/power state this module has
 * no way to detect or override.
 */
export class WakeLock {
  private readonly spawnFn: typeof nodeSpawn;
  private child: ChildProcess | undefined;

  constructor(opts: WakeLockOptions = {}) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
  }

  /** Idempotent: acts only on an actual 0<->positive transition. */
  update(liveManagedCount: number): void {
    if (process.platform !== 'darwin') return;
    const held = this.child !== undefined;
    if (!held && liveManagedCount > 0) {
      this.start();
    } else if (held && liveManagedCount === 0) {
      this.release();
    }
  }

  /** Force-stop; safe to call whether or not an assertion is held. */
  release(): void {
    if (process.platform !== 'darwin') return;
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    this.child = undefined;
  }

  private start(): void {
    const child: ChildProcess = this.spawnFn('caffeinate', ['-i', '-s', '-u'], { stdio: 'ignore' });
    child.on('error', (error) => {
      console.warn(`[agentdeck] caffeinate failed to launch: ${error.message}`);
    });
    child.unref();
    this.child = child;
  }
}
