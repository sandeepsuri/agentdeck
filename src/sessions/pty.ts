// PtyBackend: managed sessions as node-pty children. Dies with the app.
import * as pty from 'node-pty';
import type { LaunchSpec } from '../types.js';
import type { Handle, SessionBackend } from './backend.js';

export interface CommandSpec {
  file: string;
  args: string[];
}

/** agent → executable. Overridable so tests can substitute bash/cat. */
export function defaultCommandFor(spec: LaunchSpec): CommandSpec {
  return { file: spec.agent, args: spec.extraArgs ?? [] };
}

export interface PtyBackendOptions {
  commandFor?: (spec: LaunchSpec) => CommandSpec;
  cols?: number;
  rows?: number;
}

export class PtyBackend implements SessionBackend {
  private procs = new Map<string, pty.IPty>();
  private commandFor: (spec: LaunchSpec) => CommandSpec;
  private cols: number;
  private rows: number;

  constructor(opts: PtyBackendOptions = {}) {
    this.commandFor = opts.commandFor ?? defaultCommandFor;
    this.cols = opts.cols ?? 100;
    this.rows = opts.rows ?? 30;
  }

  async spawn(spec: LaunchSpec): Promise<Handle> {
    const { file, args } = this.commandFor(spec);
    // Nested-launch hygiene (T0): a managed claude must not think it's inside
    // another Claude Code session.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^CLAUDE(CODE|_CODE_)/.test(k)) env[k] = v;
    }
    Object.assign(env, spec.env ?? {});

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: spec.cwd,
      env,
    });
    const h: Handle = { id: String(proc.pid), pid: proc.pid };
    this.procs.set(h.id, proc);
    proc.onExit(() => this.procs.delete(h.id));
    return h;
  }

  private proc(h: Handle): pty.IPty {
    const p = this.procs.get(h.id);
    if (!p) throw new Error(`no live pty for handle ${h.id}`);
    return p;
  }

  write(h: Handle, data: string): void {
    this.proc(h).write(data);
  }

  onData(h: Handle, cb: (data: string) => void): void {
    this.proc(h).onData(cb);
  }

  onExit(h: Handle, cb: (exitCode: number, signal?: number) => void): void {
    this.proc(h).onExit(({ exitCode, signal }) => cb(exitCode, signal));
  }

  resize(h: Handle, cols: number, rows: number): void {
    this.proc(h).resize(cols, rows);
  }

  async kill(h: Handle, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const p = this.procs.get(h.id);
    if (p) p.kill(signal);
  }

  async list(): Promise<Handle[]> {
    return [...this.procs.values()].map((p) => ({ id: String(p.pid), pid: p.pid }));
  }
}
