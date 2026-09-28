// Folder access (Settings → Folder access): which folders AgentDeck may scan
// for repos and launch agents in. Once the user chooses folders — or the Mac
// app started the service, where the working folder means nothing — every
// repo, session cwd and Run must sit inside one of them. Before that, plain
// `npm start` keeps scanning the legacy projectsDir with no enforcement.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDeckConfig } from './config.js';
import { canonicalGrantRoot } from './personal-tasks/folder-grant.js';
import type { Repo } from './types.js';

export interface FolderAccess {
  /** Folders to scan for repos, in the user's order. */
  roots(): string[];
  /** Whether paths outside roots() are refused. */
  enforced(): boolean;
  /** True when `target` is inside a root, or inside a worktree of a repo that is. */
  allows(target: string): boolean;
}

type AccessConfig = Pick<AgentDeckConfig, 'allowedRoots' | 'projectsDir' | 'launchedByApp'>;

function canonical(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export function folderAccess(config: AccessConfig, listRepos: () => readonly Repo[] = () => []): FolderAccess {
  const roots = () => config.allowedRoots?.length
    ? [...config.allowedRoots]
    : config.projectsDir ? [config.projectsDir] : [];
  const enforced = () => Boolean(config.allowedRoots?.length) || config.launchedByApp === true;
  const inRoots = (target: string) => roots().some((root) => isWithin(target, canonical(root)));
  return {
    roots,
    enforced,
    allows(target) {
      if (!enforced()) return true;
      const resolved = canonical(target);
      if (inRoots(resolved)) return true;
      // Worktrees of an allowed repo may live elsewhere (AgentDeck's own run
      // worktrees under the data folder, or a `git worktree add ../x`).
      return listRepos().some((repo) => inRoots(canonical(repo.path))
        && (repo.worktrees ?? []).some((worktree) => isWithin(resolved, canonical(worktree.path))));
    },
  };
}

/**
 * Validates and canonicalizes the folders the user chose. Refuses the home
 * folder itself, ~/Library, and AgentDeck's data folder (via the same rule
 * as a Folder grant), so a single pick can't hand over everything.
 */
export function normalizeAllowedRoots(
  selected: readonly string[],
  options: { homeDir?: string; protectedRoots?: readonly string[] } = {},
): string[] {
  const roots: string[] = [];
  for (const root of selected) {
    const resolved = canonicalGrantRoot(root, options);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

export class FolderAccessDeniedError extends Error {
  constructor(target: string) {
    super(`AgentDeck does not have access to ${target}. Add its folder in Settings → Folder access.`);
    this.name = 'FolderAccessDeniedError';
  }
}
