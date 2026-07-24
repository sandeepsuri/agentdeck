import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('[agentdeck] skipping native notch companion build outside macOS');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'native', 'AgentDeckNotch');
const scratchPath = path.join(root, '.native-build');
const destination = path.join(root, 'dist', 'native', 'AgentDeckNotch.app');

const build = spawnSync('xcrun', [
  'swift', 'build',
  '--package-path', packagePath,
  '--scratch-path', scratchPath,
  '--configuration', 'release',
], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const binPathResult = spawnSync('xcrun', [
  'swift', 'build',
  '--package-path', packagePath,
  '--scratch-path', scratchPath,
  '--configuration', 'release',
  '--show-bin-path',
], { encoding: 'utf8' });
if (binPathResult.status !== 0) {
  process.stderr.write(binPathResult.stderr);
  process.exit(binPathResult.status ?? 1);
}

const executable = path.join(binPathResult.stdout.trim(), 'AgentDeckNotch');
if (!existsSync(executable)) {
  console.error(`[agentdeck] notch executable was not produced at ${executable}`);
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
const contents = path.join(destination, 'Contents');
const macOS = path.join(contents, 'MacOS');
mkdirSync(macOS, { recursive: true });
copyFileSync(executable, path.join(macOS, 'AgentDeckNotch'));
copyFileSync(path.join(packagePath, 'Info.plist'), path.join(contents, 'Info.plist'));

const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
if (sign.status !== 0) process.exit(sign.status ?? 1);
console.log(`[agentdeck] built native notch companion: ${destination}`);
