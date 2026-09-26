// Issue #81: turns an agent's typed filing requests into a plan the owner
// can review. Every name and destination is validated here, by AgentDeck,
// before it is recorded; warnings (overwrite, duplicates, new folders) are
// computed from the grant as it is on disk. The agent supplies only a
// document id, a file name, and a folder, never a path, a summary, or an
// approval text. Nothing here moves or creates anything.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertGrantRoot, GrantPathError } from './folder-grant.js';
import { PdfTooLargeError, readGrantedPdf } from './pdf-inventory.js';
import type { FilingPlanEntry, FilingWarning } from './types.js';

export const MAX_FILE_NAME_LENGTH = 120;
export const MAX_FOLDER_NAME_LENGTH = 80;
export const MAX_DESTINATION_DEPTH = 4;

export class FilingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingPlanError';
  }
}

// Control characters, bidi overrides, and zero-width characters could make
// a name read differently from what it is.
// eslint-disable-next-line no-control-regex
const DECEPTIVE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

function checkComponent(value: string, kind: 'file name' | 'folder name', max: number): void {
  if (value.length === 0) throw new FilingPlanError(`The ${kind} is empty.`);
  if (value.length > max) throw new FilingPlanError(`The ${kind} is longer than ${max} characters.`);
  if (/[/\\:]/.test(value)) throw new FilingPlanError(`A ${kind} may not contain /, \\ or :.`);
  if (value === '.' || value === '..') throw new FilingPlanError(`"${value}" is not a ${kind}.`);
  if (value.startsWith('.')) throw new FilingPlanError(`A ${kind} may not start with a dot.`);
  if (value !== value.trim()) throw new FilingPlanError(`A ${kind} may not start or end with a space.`);
  if (DECEPTIVE.test(value)) throw new FilingPlanError(`The ${kind} contains control or invisible characters.`);
}

/** A single PDF file name, NFC-normalized. */
export function validateFileName(input: unknown): string {
  if (typeof input !== 'string') throw new FilingPlanError('The new name must be text.');
  const name = input.normalize('NFC');
  checkComponent(name, 'file name', MAX_FILE_NAME_LENGTH);
  if (!/\.pdf$/i.test(name) || name.length <= 4) throw new FilingPlanError('The new name must end in .pdf.');
  return name;
}

/** A folder relative to the grant, as '/'-joined components; '' is the granted folder itself. */
export function validateDestination(input: unknown): string {
  if (typeof input !== 'string') throw new FilingPlanError('The destination must be text.');
  const value = input.normalize('NFC');
  if (value.startsWith('/') || value.startsWith('~')) throw new FilingPlanError('The destination must be a folder inside the granted folder.');
  const components = value.split('/').filter((component) => component !== '');
  if (components.length > MAX_DESTINATION_DEPTH) {
    throw new FilingPlanError(`The destination may be at most ${MAX_DESTINATION_DEPTH} folders deep.`);
  }
  for (const component of components) checkComponent(component, 'folder name', MAX_FOLDER_NAME_LENGTH);
  return components.join('/');
}

export interface DestinationState {
  /** False when part of the folder would have to be created. */
  exists: boolean;
}

/**
 * Walks the destination inside the grant without following anything: an
 * existing component must be a real folder, never a symlink or a file.
 */
export function inspectDestination(root: string, destination: string): DestinationState {
  assertGrantRoot(root);
  let current = root;
  for (const component of destination ? destination.split('/') : []) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { exists: false };
    }
    if (stat.isSymbolicLink()) throw new FilingPlanError('The destination goes through a link, which is never followed.');
    if (!stat.isDirectory()) throw new FilingPlanError('Part of the destination is a file, not a folder.');
  }
  return { exists: true };
}

export interface FilingSource {
  readonly path: string;
  readonly sha256: string;
}

export interface FilingRequest {
  readonly newName: string;
  readonly destination: string;
}

export interface FilingPlan {
  entries: FilingPlanEntry[];
  unplanned: { path: string; reason: string }[];
}

/** APFS and HFS+ compare names case- and normalization-insensitively by default. */
const fold = (relative: string) => relative.normalize('NFC').toLowerCase();

function join(destination: string, name: string): string {
  return destination ? `${destination}/${name}` : name;
}

function existingTarget(root: string, target: string, source: FilingSource, maxBytes?: number): FilingWarning | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(root, ...target.split('/')));
  } catch {
    return undefined;
  }
  if (!stat.isFile()) throw new FilingPlanError('Something other than a file already has that name.');
  try {
    if (readGrantedPdf(root, target, { maxBytes }).sha256 === source.sha256) {
      return { kind: 'already-filed', message: 'A file with identical content is already at this name; filing would replace it with the same bytes.' };
    }
  } catch (error) {
    if (!(error instanceof GrantPathError) && !(error instanceof PdfTooLargeError)) throw error;
  }
  return { kind: 'overwrite', message: 'A different file already has this name and would be replaced.' };
}

/**
 * Builds the reviewable plan from validated requests. Each request is
 * re-validated against the grant as it is now, so a folder swapped for a
 * link after the agent proposed it lands in `unplanned`, not in the plan.
 */
export function buildFilingPlan(
  root: string,
  sources: readonly FilingSource[],
  requests: ReadonlyMap<string, FilingRequest>,
  options: { maxBytes?: number } = {},
): FilingPlan {
  const entries: FilingPlanEntry[] = [];
  const unplanned: FilingPlan['unplanned'] = [];
  for (const source of sources) {
    const request = requests.get(source.path);
    if (!request) {
      unplanned.push({ path: source.path, reason: 'No filing was proposed; the file stays where it is.' });
      continue;
    }
    try {
      const newName = validateFileName(request.newName);
      const destination = validateDestination(request.destination);
      const target = join(destination, newName);
      const warnings: FilingWarning[] = [];
      if (fold(target) === fold(source.path)) {
        warnings.push({ kind: 'unchanged', message: 'The file already has this name and folder.' });
      } else {
        const { exists } = inspectDestination(root, destination);
        if (!exists) warnings.push({ kind: 'new-folder', message: `The folder "${destination}" does not exist yet and would be created.` });
        else {
          const existing = existingTarget(root, target, source, options.maxBytes);
          if (existing) warnings.push(existing);
        }
      }
      entries.push({ source: source.path, sourceSha256: source.sha256, newName, destination, target, warnings });
    } catch (error) {
      if (!(error instanceof FilingPlanError) && !(error instanceof GrantPathError)) throw error;
      unplanned.push({ path: source.path, reason: `The proposal was refused: ${error.message}` });
    }
  }

  for (const entry of entries) {
    const sameTarget = entries.filter((other) => other !== entry && fold(other.target) === fold(entry.target));
    if (sameTarget.length > 0 && !entry.warnings.some((warning) => warning.kind === 'unchanged')) {
      entry.warnings.push({ kind: 'same-target', message: `${sameTarget.map((other) => other.source).join(', ')} would get the same name in the same folder.` });
    }
    const sameContent = sources.filter((other) => other.path !== entry.source && other.sha256 === entry.sourceSha256);
    if (sameContent.length > 0) {
      entry.warnings.push({ kind: 'duplicate-content', message: `Identical content to ${sameContent.map((other) => other.path).join(', ')}.` });
    }
  }
  return { entries, unplanned };
}

/** A stable digest of what the plan would do, bound to the grant and to each source's content. */
export function filingPlanDigest(grantId: string, entries: readonly FilingPlanEntry[]): string {
  const canonical = [...entries]
    .map((entry) => [entry.source, entry.sourceSha256, entry.destination, entry.newName])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ v: 1, grantId, entries: canonical })).digest('hex');
}
