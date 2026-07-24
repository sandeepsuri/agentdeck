#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'serve', ...args] = process.argv.slice(2);
const hookPath = path.join(root, 'bin', 'agentdeck-hook.mjs');

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`[agentdeck] Node.js 20 or newer is required (current: ${process.version}). Run \`nvm use\` and try again.`);
  process.exit(1);
}

function repoFrom(value) {
  const cwd = value && !value.startsWith('--') ? path.resolve(value) : process.cwd();
  return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

try {
  if (command === 'serve') {
    process.env.NODE_ENV ??= 'production';
    const { startServer } = await import('../dist/server/index.js');
    await startServer();
  } else if (command === 'post') {
    const { runPost } = await import('../dist/cli/post.js');
    await runPost(args);
  } else if (command === 'install-hooks' || command === 'uninstall-hooks') {
    const hooks = await import('../dist/hooks/install.js');
    const userOnly = args.includes('--user');
    const repoArg = args.find((arg) => !arg.startsWith('--'));
    if (!userOnly || repoArg) {
      const repo = repoFrom(repoArg);
      command === 'install-hooks' ? hooks.installClaudeHooks(repo, hookPath) : hooks.uninstallClaudeHooks(repo);
      console.log(`[agentdeck] ${command === 'install-hooks' ? 'installed' : 'removed'} Claude hooks: ${repo}`);
    }
    if (userOnly) {
      const config = path.join(os.homedir(), '.codex', 'config.toml');
      command === 'install-hooks' ? hooks.installCodexHooks(config, hookPath) : hooks.uninstallCodexHooks(config);
      console.log(`[agentdeck] ${command === 'install-hooks' ? 'installed' : 'removed'} Codex notify: ${config}`);
    }
  } else if (command === '--help' || command === 'help') {
    console.log('agentdeck [serve]\nagentdeck post --event <event> [--task ID] [--progress 0-100] [--files a,b] [-m text]\nagentdeck install-hooks [repo|--user]\nagentdeck uninstall-hooks [repo|--user]');
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`[agentdeck] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
