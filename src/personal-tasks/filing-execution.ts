// Issue #82: carries out one approved move from a filing proposal. This is
// AgentDeck's own code acting on the owner's approval; no model is in the
// loop. Each move re-checks, against the disk as it is now:
// - the granted folder still resolves to itself;
// - the target is still a valid name and folder inside the grant;
// - no symlink sits anywhere on the source or destination path;
// - the source still has the exact content the plan was built from;
// - a target is replaced only when the owner approved that replacement and
//   it still holds the content the proposal showed.
// A move that does not replace anything uses link-then-unlink, so a file
// that appears at the target at the last moment makes the link fail rather
// than being overwritten. An interrupted move is reconciled from the disk
// (reconcileMove), never redone.
//
// Limits: Node has no renameat/linkat, so the checks and the effect use
// path strings. A folder swapped for a link, or a target replaced, in the
// instant between the last check and the rename is not caught beforehand;
// the post-move identity check reports it as uncertain rather than moved.
// Volumes without hard links are refused rather than copied, so a move
// never has a window where it could replace a file it did not check.
import fs from 'node:fs';
import path from 'node:path';
import { assertGrantRoot, fingerprintGrantedFile, GrantPathError, type FileFingerprint } from './folder-grant.js';
import { FilingPlanError, inspectDestination, validateDestination, validateFileName } from './filing-plan.js';
import { DEFAULT_MAX_PDF_BYTES } from './pdf-inventory.js';
import type { FilingReceipt } from './types.js';

/** What one move needs: the receipt's source, digests, target, and the owner's replacement decision. */
export type FilingMoveItem = Pick<FilingReceipt, 'source' | 'sourceSha256' | 'target' | 'overwrite' | 'targetSha256'>
  & Partial<Pick<FilingReceipt, 'movedDev' | 'movedIno' | 'replaced'>>;

export type FilingMoveOutcome =
  | { state: 'moved'; replaced: boolean }
  | { state: 'failed'; reason: string }
  /** Something went wrong after the file system was touched. */
  | { state: 'uncertain'; reason: string };

export interface MoveOptions {
  maxBytes?: number;
  /** Called once, after every check passes and before the first change on disk; the caller persists its intent here. */
  beforeEffect?: (source: FileFingerprint) => void;
}

/** Re-validates a target exactly as the plan builder did, refusing anything it would not have produced. */
function checkTarget(target: string): { destination: string; name: string } {
  const slash = target.lastIndexOf('/');
  const destination = slash < 0 ? '' : target.slice(0, slash);
  const name = validateFileName(target.slice(slash + 1));
  if (validateDestination(destination) !== destination || name !== target.slice(slash + 1)) {
    throw new FilingPlanError('The target is not a plain folder and name inside the granted folder.');
  }
  return { destination, name };
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

/** Creates each missing destination folder, one component at a time, refusing a link or file in the way. */
function makeDestination(root: string, destination: string): void {
  let current = root;
  for (const component of destination ? destination.split('/') : []) {
    current = path.join(current, component);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FilingPlanError('The destination goes through a link, which is never followed.');
  }
}

const APPEARED = 'Something appeared at this name just before the move; nothing was replaced and the file was left where it is.';
const CHANGED_DURING = 'The file changed during the move; it was left where it is.';

const sameFile = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;


/** Moves one approved file inside the grant, or explains why it did not. */
export function moveGrantedPdf(root: string, item: FilingMoveItem, options: MoveOptions = {}): FilingMoveOutcome {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  let touched = false;
  try {
    assertGrantRoot(root);
    const { destination } = checkTarget(item.target);
    const source = fingerprintGrantedFile(root, item.source, maxBytes);
    if (source.sha256 !== item.sourceSha256) {
      return { state: 'failed', reason: 'The file has changed since the plan was proposed; it was left where it is.' };
    }
    const { exists } = inspectDestination(root, destination);
    const sourcePath = path.join(root, ...item.source.split('/'));
    const targetPath = path.join(root, ...item.target.split('/'));
    const existing = exists ? lstatOrUndefined(targetPath) : undefined;

    if (existing && !sameFile(existing, source)) {
      if (!item.overwrite || !item.targetSha256) {
        return { state: 'failed', reason: 'A file already has this name in that folder; nothing was replaced and the file was left where it is.' };
      }
      if (existing.isSymbolicLink() || !existing.isFile()) {
        return { state: 'failed', reason: 'Something other than a file has this name; nothing was replaced.' };
      }
      if (fingerprintGrantedFile(root, item.target, maxBytes).sha256 !== item.targetSha256) {
        return { state: 'failed', reason: 'The file at this name has changed since you approved replacing it; nothing was replaced.' };
      }
      options.beforeEffect?.(source);
      touched = true;
      fs.renameSync(sourcePath, targetPath);
      if (!sameFile(fs.lstatSync(targetPath), source)) {
        return { state: 'uncertain', reason: 'A different file reached the target during the move. Check both names in the folder.' };
      }
      return { state: 'moved', replaced: true };
    }

    if (existing && source.nlink > 1) {
      // rename(2) between two links to one file does nothing, so never claim it moved.
      return { state: 'failed', reason: 'The file at this name is another link to this same file; nothing was changed.' };
    }
    options.beforeEffect?.(source);
    touched = true;
    if (existing) {
      // The same directory entry under a name that differs only by case or Unicode form.
      fs.renameSync(sourcePath, targetPath);
      return { state: 'moved', replaced: false };
    }
    makeDestination(root, destination);
    try {
      fs.linkSync(sourcePath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') {
        return { state: 'failed', reason: APPEARED };
      }
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
        return { state: 'failed', reason: 'This disk cannot move the file without risking a replacement, so it was left where it is.' };
      }
      throw error;
    }
    if (!sameFile(fs.lstatSync(targetPath), source)) {
      // The source name was swapped after it was checked; undo our link only.
      fs.unlinkSync(targetPath);
      return { state: 'failed', reason: CHANGED_DURING };
    }
    fs.unlinkSync(sourcePath);
    return { state: 'moved', replaced: false };
  } catch (error) {
    const reason = error instanceof GrantPathError || error instanceof FilingPlanError
      ? error.message
      : `The file system refused the move (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`;
    return touched
      ? { state: 'uncertain', reason: `${reason} The move had started. Check both names in the folder.` }
      : { state: 'failed', reason: `${reason} The file was left where it is.` };
  }
}

type Observed = FileFingerprint | 'missing' | 'unreadable';

function observe(root: string, relative: string): Observed {
  try {
    return fingerprintGrantedFile(root, relative, DEFAULT_MAX_PDF_BYTES);
  } catch (error) {
    return error instanceof GrantPathError && error.code === 'not-found' ? 'missing' : 'unreadable';
  }
}

export type ReconciledMove =
  | { state: 'moved' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain'; reason: string };

/**
 * Decides what happened to a move that was under way when AgentDeck
 * stopped, from the disk alone. It completes only the one safe case — the
 * link was made but the old name not yet removed, so exactly two names
 * share the file — and otherwise never moves anything; what it cannot
 * prove is reported as uncertain. When both names reach one file with a
 * single name, a case-only rename finished: nothing is removed.
 */
export function reconcileMove(root: string, item: FilingMoveItem): ReconciledMove {
  const uncertain: ReconciledMove = {
    state: 'uncertain',
    reason: 'AgentDeck stopped while moving this file and could not confirm what happened. Check both names in the folder.',
  };
  try {
    assertGrantRoot(root);
  } catch {
    return { ...uncertain, reason: 'AgentDeck stopped while moving this file, and the granted folder is no longer available to check.' };
  }
  const source = observe(root, item.source);
  const target = observe(root, item.target);
  const recorded = (file: Observed) => typeof file === 'object'
    && (item.movedDev === undefined || file.dev === item.movedDev)
    && (item.movedIno === undefined || file.ino === item.movedIno);
  if ((typeof source === 'object' && !recorded(source)) || (typeof target === 'object' && target.sha256 === item.sourceSha256 && !recorded(target))) {
    return uncertain;
  }
  if (typeof source === 'object' && typeof target === 'object' && sameFile(source, target) && source.sha256 === item.sourceSha256) {
    if (source.nlink === 1) return { state: 'moved' };
    if (source.nlink !== 2) return uncertain;
    try {
      fs.unlinkSync(path.join(root, ...item.source.split('/')));
      return { state: 'moved' };
    } catch {
      return uncertain;
    }
  }
  if (source === 'missing' && typeof target === 'object' && target.sha256 === item.sourceSha256) return { state: 'moved' };
  const untouched = typeof source === 'object' && source.sha256 === item.sourceSha256
    && (target === 'missing' || (item.overwrite && typeof target === 'object' && target.sha256 === item.targetSha256));
  if (untouched) return { state: 'failed', reason: 'AgentDeck stopped before this file was moved; it was left where it was.' };
  return uncertain;
}

/** Restores a recorded move only while the exact moved inode remains at its target. */
export function undoGrantedPdf(root: string, item: FilingMoveItem, beforeEffect: () => void): ReconciledMove {
  if (item.replaced ?? item.overwrite) return { state: 'failed', reason: 'This move replaced a previous file. Its original destination cannot be restored automatically.' };
  if (item.movedDev === undefined || item.movedIno === undefined) {
    return { state: 'failed', reason: 'This older move has no recorded file identity, so undo cannot prove the destination is still the moved file.' };
  }
  try {
    assertGrantRoot(root);
    checkTarget(item.target);
    const moved = fingerprintGrantedFile(root, item.target, DEFAULT_MAX_PDF_BYTES);
    if (moved.nlink !== 1) return { state: 'failed', reason: 'The destination has another hard link, so undo cannot prove it is safe to restore.' };
    if (moved.sha256 !== item.sourceSha256 || moved.dev !== item.movedDev || moved.ino !== item.movedIno) {
      return { state: 'failed', reason: 'The destination changed after filing; nothing was overwritten.' };
    }
    const source = observe(root, item.source);
    if (source !== 'missing') return { state: 'failed', reason: 'The original name is occupied or cannot be checked; nothing was overwritten.' };
    const outcome = moveGrantedPdf(root, {
      source: item.target, sourceSha256: item.sourceSha256, target: item.source, overwrite: false,
    }, { beforeEffect });
    return outcome.state === 'moved' ? { state: 'moved' } : outcome;
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : 'The original and destination names could not be checked.' };
  }
}

/** A crash during undo is settled from both names and the recorded inode. */
export function reconcileUndo(root: string, item: FilingMoveItem): ReconciledMove {
  if (item.movedDev === undefined || item.movedIno === undefined) return { state: 'uncertain', reason: 'The file identity was not recorded before undo.' };
  const source = observe(root, item.source);
  const target = observe(root, item.target);
  const matches = (file: Observed) => typeof file === 'object' && file.sha256 === item.sourceSha256
    && file.dev === item.movedDev && file.ino === item.movedIno;
  if (matches(source) && target === 'missing') return { state: 'moved' };
  if (source === 'missing' && matches(target)) return { state: 'failed', reason: 'Undo stopped before the file was restored; the destination is unchanged.' };
  if (matches(source) && matches(target)) {
    try {
      assertGrantRoot(root);
      if (!matches(observe(root, item.source)) || !matches(observe(root, item.target))) return { state: 'uncertain', reason: 'One of the names changed during undo recovery; check both names.' };
      fs.unlinkSync(path.join(root, ...item.target.split('/')));
      return { state: 'moved' };
    } catch { /* leave both names for inspection */ }
  }
  return { state: 'uncertain', reason: 'Undo stopped with conflicting files. Check both names; nothing was overwritten.' };
}
