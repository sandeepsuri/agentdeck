// Canonical-path checks for a Folder grant (CONTEXT.md). A grant is one
// folder the owner picked; every read goes through openGrantedPdf, which
// refuses anything outside that folder, any symlink on the way (even one
// that points back inside), and anything that is not a real PDF. The grant
// root itself is re-checked on every call, so a folder that was moved or
// swapped for a symlink after the grant stops being readable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type GrantPathErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'not-a-directory'
  | 'too-broad'
  | 'grant-unavailable'
  | 'outside-grant'
  | 'symlink'
  | 'unsupported-type';

export class GrantPathError extends Error {
  constructor(readonly code: GrantPathErrorCode, message: string) {
    super(message);
    this.name = 'GrantPathError';
  }
}

export interface GrantRootOptions {
  homeDir?: string;
  /** Folders a grant may never cover, such as AgentDeck's own data directory. */
  protectedRoots?: readonly string[];
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/** Resolves the folder the owner picked to its canonical path, refusing anything broader than one ordinary folder. */
export function canonicalGrantRoot(selectedPath: string, options: GrantRootOptions = {}): string {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath) || selectedPath.includes('\0')) {
    throw new GrantPathError('invalid-path', 'The selected folder must be an absolute path.');
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(selectedPath);
  } catch {
    throw new GrantPathError('not-found', 'The selected folder does not exist.');
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new GrantPathError('not-a-directory', 'Choose a folder, not a file.');
  }
  const homeDir = realpathOrUndefined(options.homeDir ?? os.homedir()) ?? options.homeDir ?? os.homedir();
  const components = canonical.split(path.sep).filter(Boolean);
  const tooBroad = components.length < 2
    || isWithin(homeDir, canonical)
    || isWithin(canonical, path.join(homeDir, 'Library'))
    || (options.protectedRoots ?? []).some((protectedRoot) => {
      const resolved = realpathOrUndefined(protectedRoot) ?? protectedRoot;
      return isWithin(canonical, resolved) || isWithin(resolved, canonical);
    });
  if (tooBroad) {
    throw new GrantPathError('too-broad', 'That folder is too broad to grant. Choose one specific folder, such as a folder inside Documents.');
  }
  return canonical;
}

function assertGrantRoot(root: string): void {
  if (realpathOrUndefined(root) !== root || !fs.statSync(root).isDirectory()) {
    throw new GrantPathError('grant-unavailable', 'The granted folder was moved, replaced, or removed.');
  }
}

function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

export interface GrantedPdfHandle {
  /** An open, read-only descriptor; the caller closes it. */
  readonly fd: number;
  readonly relativePath: string;
  readonly stat: fs.Stats;
}

/**
 * Opens one PDF inside the grant. The descriptor is opened with O_NOFOLLOW
 * and matched against the component-by-component lstat walk, so a symlink
 * planted between the check and the open is refused rather than followed.
 */
export function openGrantedPdf(root: string, requestedPath: string): GrantedPdfHandle {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.includes('\0')) {
    throw new GrantPathError('invalid-path', 'A file path inside the granted folder is required.');
  }
  if (path.isAbsolute(requestedPath)) {
    throw new GrantPathError('outside-grant', 'That file is outside the granted folder.');
  }
  const relativePath = path.normalize(requestedPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || relativePath === '.') {
    throw new GrantPathError('outside-grant', 'That file is outside the granted folder.');
  }
  assertGrantRoot(root);

  let current = root;
  let stat: fs.Stats | undefined;
  for (const component of relativePath.split(path.sep)) {
    current = path.join(current, component);
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new GrantPathError('not-found', 'That file no longer exists in the granted folder.');
    }
    if (stat.isSymbolicLink()) {
      throw new GrantPathError('symlink', 'Links are not followed inside a granted folder.');
    }
  }
  if (!isWithin(current, root) || !isWithin(fs.realpathSync(current), root)) {
    throw new GrantPathError('outside-grant', 'That file is outside the granted folder.');
  }
  if (!stat!.isFile() || !isPdfName(current)) {
    throw new GrantPathError('unsupported-type', 'Only PDF files can be inspected.');
  }

  let fd: number;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new GrantPathError('symlink', 'Links are not followed inside a granted folder.');
    }
    throw new GrantPathError('not-found', 'That file no longer exists in the granted folder.');
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat!.ino || opened.dev !== stat!.dev || !opened.isFile()) {
      throw new GrantPathError('symlink', 'The file changed while it was being opened.');
    }
    const header = Buffer.alloc(5);
    const read = fs.readSync(fd, header, 0, 5, 0);
    if (read < 5 || header.toString('latin1') !== '%PDF-') {
      throw new GrantPathError('unsupported-type', 'That file is not a PDF.');
    }
    return { fd, relativePath, stat: opened };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export interface GrantedPdfListing {
  files: { relativePath: string; size: number; modifiedAt: string }[];
  truncated: boolean;
}

export interface ListingLimits {
  maxFiles?: number;
  maxDepth?: number;
}

/** A bounded listing of `.pdf` names in the grant, for the owner to choose from. Hidden entries and symlinks are skipped. */
export function listGrantedPdfs(root: string, limits: ListingLimits = {}): GrantedPdfListing {
  const maxFiles = limits.maxFiles ?? 500;
  const maxDepth = limits.maxDepth ?? 3;
  try {
    assertGrantRoot(root);
  } catch {
    throw new GrantPathError('grant-unavailable', 'The granted folder was moved, replaced, or removed.');
  }
  const files: GrantedPdfListing['files'] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && isPdfName(entry.name)) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        const stat = fs.lstatSync(full);
        files.push({ relativePath: path.relative(root, full), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
  };
  walk(root, 1);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, truncated };
}
