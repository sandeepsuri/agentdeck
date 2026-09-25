// Where the spike keeps credentials, tokens, journals, and results: always
// outside the repository, owner-only, and removable in one step.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));

export function spikeDir(): string {
  const dir = path.resolve(process.env.AGENTDECK_EMAIL_SPIKE_DIR ?? path.join(os.homedir(), '.agentdeck', 'spikes', 'email'));
  assertOutsideRepo(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resolves symlinks before checking, so a link into the checkout is refused too. */
export function assertOutsideRepo(file: string): string {
  const real = realpathOfNearestAncestor(path.resolve(file));
  if (real === repoRoot || real.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Refusing to keep spike credentials or artifacts inside the repository (${real}).`);
  }
  return file;
}

/** realpath for a path that may not exist yet: resolve the deepest existing ancestor. */
function realpathOfNearestAncestor(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realpathOfNearestAncestor(parent), path.basename(file));
  }
}

export function readPrivateJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writePrivateJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Read a secret from the login Keychain, falling back to an environment
 * variable. Store it with:
 *   security add-generic-password -s <service> -a <account> -w
 */
export function keychainSecret(service: string, account: string, envFallback: string): string {
  const fromEnv = process.env[envFallback];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`No secret found. Run: security add-generic-password -s ${service} -a ${account} -w   (or set ${envFallback})`);
  }
}
