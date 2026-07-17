import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutomationDeniedError } from './index.js';

const execFileAsync = promisify(execFile);

export type OsaRunner = (script: string) => Promise<string>;

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string') return stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  }
  return error instanceof Error ? error.message : String(error);
}

export function osaRunner(app: 'Terminal' | 'iTerm2'): OsaRunner {
  return async (script) => {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      return stdout.trim();
    } catch (error) {
      if (errorText(error).includes('-1743')) throw new AutomationDeniedError(app);
      throw error;
    }
  };
}

export async function appRunning(run: OsaRunner, name: string): Promise<boolean> {
  return (await run(`tell application "System Events" to (name of processes) contains "${name}"`)) === 'true';
}

export function numericId(value: string, label: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

export function quoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
