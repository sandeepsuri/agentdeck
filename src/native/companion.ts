import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunningCompanion {
  close: () => void;
}

export function launchNativeCompanion(port: number): RunningCompanion | undefined {
  if (process.platform !== 'darwin' || process.env.AGENTDECK_NOTCH === '0') return undefined;
  const executable = path.join(
    import.meta.dirname,
    'AgentDeckNotch.app',
    'Contents',
    'MacOS',
    'AgentDeckNotch',
  );
  if (!fs.existsSync(executable)) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[agentdeck] native notch companion is unavailable; continuing with the browser UI');
    }
    return undefined;
  }
  const child: ChildProcess = spawn(executable, [
    '--port', String(port),
    '--parent-pid', String(process.pid),
  ], {
    detached: false,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    console.warn(`[agentdeck] native notch companion failed to launch: ${error.message}`);
  });
  child.unref();
  return {
    close: () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}
