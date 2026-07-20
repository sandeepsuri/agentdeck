import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentType } from '../types.js';

const resolvedCache = new Map<AgentType, string>();

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findExecutableInPath(name: string, pathValue = process.env.PATH ?? ''): string | undefined {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * GUI apps and development runners often inherit a smaller PATH than an
 * interactive shell. Resolve the agent from PATH, common user install
 * locations, including version-manager bins.
 */
export function resolveAgentExecutable(agent: AgentType): string | undefined {
  const cached = resolvedCache.get(agent);
  if (cached && isExecutable(cached)) return cached;
  const fromPath = findExecutableInPath(agent);
  if (fromPath) {
    resolvedCache.set(agent, fromPath);
    return fromPath;
  }

  const home = os.homedir();
  const directories = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.codex', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try {
    directories.unshift(...fs.readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmRoot, entry.name, 'bin'))
      .sort()
      .reverse());
  } catch { /* nvm is optional */ }
  const commonCandidates = directories.map((directory) => path.join(directory, agent));
  const common = commonCandidates.find(isExecutable);
  if (common) {
    resolvedCache.set(agent, common);
    return common;
  }

  return undefined;
}
