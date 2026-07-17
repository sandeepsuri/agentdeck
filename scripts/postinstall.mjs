// T0 finding: npm strips the exec bit from node-pty's prebuilt spawn-helper,
// which makes every PTY spawn fail with "posix_spawnp failed". Restore it.
// Tolerant: node-pty may not be installed yet (it arrives in T3).
import fs from 'node:fs';
import path from 'node:path';

const prebuilds = path.resolve('node_modules/node-pty/prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`[postinstall] chmod +x ${helper}`);
    }
  }
}

for (const file of ['bin/agentdeck.mjs', 'bin/agentdeck-hook.mjs']) {
  try { fs.chmodSync(path.resolve(file), 0o755); } catch {}
}
