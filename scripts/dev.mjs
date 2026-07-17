// Dev runner: fastify API (tsx watch) on port+1, vite dev server on the
// configured port (default 4040) proxying /api and /ws to the API process.
// One Ctrl-C kills both.
import { spawn } from 'node:child_process';

const children = [];
function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    // if one side dies, take the other down too
    shutdown(code ?? 0);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'npx', ['tsx', 'watch', 'src/server/index.ts'], { AGENTDECK_DEV: '1' });
run('ui', 'npx', ['vite']);
