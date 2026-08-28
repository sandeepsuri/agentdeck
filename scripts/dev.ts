// Dev runner: Fastify API on port+1 and one Vite listener per concrete UI
// interface. Loopback is always present; Tailscale adds its raw IP only.
import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { detectTailscaleInterface } from '../src/server/tailscale.js';
import { devUiListeners } from '../src/server/dev-ui.js';

const config = loadConfig();
const tailscale = await detectTailscaleInterface();
const children: ChildProcess[] = [];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => shutdown(code ?? 0));
  children.push(child);
}

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('npx', ['tsx', 'watch', 'src/server/index.ts'], { AGENTDECK_DEV: '1' });
for (const listener of devUiListeners(config.port, tailscale)) {
  run('npx', ['vite'], {
    AGENTDECK_VITE_HOST: listener.bindHost,
    AGENTDECK_VITE_ALLOWED_HOSTS: listener.allowedHosts.join(','),
  });
  console.log(`[agentdeck] ${listener.label} dev UI: ${listener.url}`);
}
