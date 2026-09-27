// Canonical-path checks for a Folder grant (CONTEXT.md). A grant is one
// folder the owner picked; every read goes through openGrantedPdf, which
// refuses anything outside that folder, any symlink on the way (even one
// that points back inside), and anything that is not a real PDF. The grant
// root itself is re-checked on every call, so a folder that was moved or
// swapped for a symlink after the grant stops being readable.
import { createHash } from 'node:crypto';
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
  | 'unsupported-type'
  | 'too-large';

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

/** Throws unless the grant root still resolves to itself and is a folder. */
export function assertGrantRoot(root: string): void {
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

/** lstat-walks each component under the root, refusing any symlink on the way, even one pointing back inside. */
function walkWithoutLinks(root: string, components: readonly string[]): { current: string; stat: fs.Stats } {
  let current = root;
  let stat: fs.Stats | undefined;
  for (const component of components) {
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
  return { current, stat: stat! };
}

/**
 * Opens a walked file read-only with O_NOFOLLOW and matches it to the walk,
 * so a symlink planted between the check and the open is refused rather
 * than followed. The caller closes the descriptor.
 */
function openWalkedFile(current: string, walked: fs.Stats): { fd: number; opened: fs.Stats } {
  let fd: number;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new GrantPathError('symlink', 'Links are not followed inside a granted folder.');
    }
    throw new GrantPathError('not-found', 'That file no longer exists in the granted folder.');
  }
  const opened = fs.fstatSync(fd);
  if (opened.ino !== walked.ino || opened.dev !== walked.dev || !opened.isFile()) {
    fs.closeSync(fd);
    throw new GrantPathError('symlink', 'The file changed while it was being opened.');
  }
  return { fd, opened };
}

/**
 * Opens one PDF inside the grant. Every component is walked without following
 * links and the descriptor is matched to the walk (openWalkedFile).
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

  const { current, stat } = walkWithoutLinks(root, relativePath.split(path.sep));
  if (!isWithin(current, root) || !isWithin(fs.realpathSync(current), root)) {
    throw new GrantPathError('outside-grant', 'That file is outside the granted folder.');
  }
  if (!stat.isFile() || !isPdfName(current)) {
    throw new GrantPathError('unsupported-type', 'Only PDF files can be inspected.');
  }

  const { fd, opened } = openWalkedFile(current, stat);
  try {
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

/** A bounded list of existing sub-folders, for choosing filing destinations. Hidden entries and symlinks are skipped. */
export function listGrantFolders(root: string, limits: ListingLimits = {}): { folders: string[]; truncated: boolean } {
  const maxFolders = limits.maxFiles ?? 200;
  const maxDepth = limits.maxDepth ?? 3;
  assertGrantRoot(root);
  const folders: string[] = [];
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
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      if (folders.length >= maxFolders) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      folders.push(path.relative(root, full));
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return { folders, truncated };
}

export interface FileFingerprint {
  readonly sha256: string;
  readonly ino: number;
  readonly dev: number;
  /** Names this file has; more than one means another hard link exists. */
  readonly nlink: number;
}

/** A '/'-separated grant-relative path as components, refusing absolute paths, empty components, and '.' or '..'. */
function componentsOf(relative: string): string[] {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new GrantPathError('invalid-path', 'A file path inside the granted folder is required.');
  }
  const components = relative.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new GrantPathError('outside-grant', 'That file is outside the granted folder.');
  }
  return components;
}

/**
 * Hashes one file inside the grant, whatever its type, without following
 * any link (issue #82: filing targets and moves).
 */
export function fingerprintGrantedFile(root: string, relative: string, maxBytes: number): FileFingerprint {
  assertGrantRoot(root);
  const { current, stat } = walkWithoutLinks(root, componentsOf(relative));
  if (!stat.isFile()) throw new GrantPathError('unsupported-type', 'Something other than a file has that name.');
  if (stat.size > maxBytes) throw new GrantPathError('too-large', `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB and was not read.`);
  const { fd, opened } = openWalkedFile(current, stat);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let read: number;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    return { sha256: hash.digest('hex'), ino: opened.ino, dev: opened.dev, nlink: opened.nlink };
  } finally {
    fs.closeSync(fd);
  }
}
