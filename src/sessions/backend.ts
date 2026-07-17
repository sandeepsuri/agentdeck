// SessionBackend interface: `onExit` lets the manager observe lifecycle to
// mark sessions exited; the optional `signal` on kill supports the manager's
// SIGTERM→SIGKILL escalation.
import type { LaunchSpec } from '../types.js';

export interface Handle {
  /** backend-scoped identifier (PtyBackend: same as pid as string) */
  id: string;
  pid: number;
}

export interface SessionBackend {
  spawn(spec: LaunchSpec): Promise<Handle>;
  /** keystrokes / injected prompts */
  write(h: Handle, data: string): void;
  /** stream output */
  onData(h: Handle, cb: (data: string) => void): void;
  onExit(h: Handle, cb: (exitCode: number, signal?: number) => void): void;
  resize(h: Handle, cols: number, rows: number): void;
  kill(h: Handle, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /** TmuxBackend: re-adopt after restart. PtyBackend: live handles only. */
  list(): Promise<Handle[]>;
}
