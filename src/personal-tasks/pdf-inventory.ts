// The bounded, deterministic operation behind an inventory task: AgentDeck's
// own code reads one granted PDF and reports facts about it. No model sees
// the content, and text inside the document is never interpreted as an
// instruction — only a few structural markers are matched.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openGrantedPdf } from './folder-grant.js';
import type { PdfInventoryEntry } from './types.js';

export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

export class PdfTooLargeError extends Error {
  readonly code = 'too-large';
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB and was not read.`);
    this.name = 'PdfTooLargeError';
  }
}

export interface PdfFacts {
  pdfVersion: string | undefined;
  pageCount: number | undefined;
  encrypted: boolean;
}

export function readPdfFacts(bytes: Buffer): PdfFacts {
  const text = bytes.toString('latin1');
  const version = /^%PDF-(\d\.\d)/.exec(text)?.[1];
  let treeCount: number | undefined;
  for (const match of text.matchAll(/obj\b([\s\S]*?)\bendobj/g)) {
    const body = match[1] ?? '';
    if (!/\/Type\s*\/Pages\b/.test(body)) continue;
    const count = /\/Count\s+(\d+)/.exec(body)?.[1];
    if (count !== undefined) treeCount = Math.max(treeCount ?? 0, Number(count));
  }
  const pageObjects = [...text.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)].length;
  return {
    pdfVersion: version,
    pageCount: treeCount ?? (pageObjects > 0 ? pageObjects : undefined),
    encrypted: /\/Encrypt\b/.test(text),
  };
}

export interface InspectLimits {
  maxBytes?: number;
}

export function inspectPdf(root: string, requestedPath: string, limits: InspectLimits = {}): PdfInventoryEntry {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  const handle = openGrantedPdf(root, requestedPath);
  try {
    if (handle.stat.size > maxBytes) throw new PdfTooLargeError(maxBytes);
    const bytes = Buffer.alloc(handle.stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle.fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const content = bytes.subarray(0, offset);
    const facts = readPdfFacts(content);
    const entry: PdfInventoryEntry = {
      path: handle.relativePath,
      name: path.basename(handle.relativePath),
      size: content.length,
      modifiedAt: handle.stat.mtime.toISOString(),
      sha256: createHash('sha256').update(content).digest('hex'),
      encrypted: facts.encrypted,
    };
    if (facts.pdfVersion !== undefined) entry.pdfVersion = facts.pdfVersion;
    if (facts.pageCount !== undefined) entry.pageCount = facts.pageCount;
    return entry;
  } finally {
    fs.closeSync(handle.fd);
  }
}
