import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalGrantRoot, GrantPathError, listGrantedPdfs, openGrantedPdf } from './folder-grant.js';

const PDF = '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n';

let base: string;
let home: string;
let root: string;
let outside: string;

function write(file: string, content = PDF): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof GrantPathError) return error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-grant-')));
  home = path.join(base, 'home');
  root = path.join(home, 'Documents', 'Taxes');
  outside = path.join(home, 'Private');
  write(path.join(root, 'w2.pdf'));
  write(path.join(root, 'receipts', 'march.PDF'));
  write(path.join(root, 'notes.txt'), 'hello');
  write(path.join(root, 'fake.pdf'), 'not a pdf');
  write(path.join(root, '.hidden.pdf'));
  write(path.join(outside, 'secret.pdf'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('canonicalGrantRoot', () => {
  it('returns the realpath of a selected folder', () => {
    fs.symlinkSync(root, path.join(home, 'taxes-link'));
    expect(canonicalGrantRoot(path.join(home, 'taxes-link'), { homeDir: home })).toBe(root);
  });

  it('refuses the filesystem root, a top-level folder, the home folder, and its ancestors', () => {
    for (const selected of ['/', '/Users', home, path.dirname(home)]) {
      expect(codeOf(() => canonicalGrantRoot(selected, { homeDir: home }))).toBe('too-broad');
    }
  });

  it('refuses the Library folder and anything protected', () => {
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    expect(codeOf(() => canonicalGrantRoot(path.join(home, 'Library', 'Keychains'), { homeDir: home }))).toBe('too-broad');
    const protectedDir = path.join(home, '.agentdeck');
    fs.mkdirSync(protectedDir);
    expect(codeOf(() => canonicalGrantRoot(protectedDir, { homeDir: home, protectedRoots: [protectedDir] }))).toBe('too-broad');
  });

  it('refuses a relative path, a file, and a missing folder', () => {
    expect(codeOf(() => canonicalGrantRoot('Documents', { homeDir: home }))).toBe('invalid-path');
    expect(codeOf(() => canonicalGrantRoot(path.join(root, 'w2.pdf'), { homeDir: home }))).toBe('not-a-directory');
    expect(codeOf(() => canonicalGrantRoot(path.join(home, 'nope'), { homeDir: home }))).toBe('not-found');
  });
});

describe('openGrantedPdf', () => {
  it('opens a PDF inside the grant, including nested ones', () => {
    const top = openGrantedPdf(root, 'w2.pdf');
    expect(top.relativePath).toBe('w2.pdf');
    fs.closeSync(top.fd);
    const nested = openGrantedPdf(root, 'receipts/march.PDF');
    expect(nested.relativePath).toBe(path.join('receipts', 'march.PDF'));
    fs.closeSync(nested.fd);
  });

  it('refuses absolute paths and traversal out of the root', () => {
    expect(codeOf(() => openGrantedPdf(root, path.join(outside, 'secret.pdf')))).toBe('outside-grant');
    expect(codeOf(() => openGrantedPdf(root, '../../Private/secret.pdf'))).toBe('outside-grant');
    expect(codeOf(() => openGrantedPdf(root, 'receipts/../../Taxes/../Private/secret.pdf'))).toBe('outside-grant');
    expect(codeOf(() => openGrantedPdf(root, ''))).toBe('invalid-path');
    expect(codeOf(() => openGrantedPdf(root, 'w2\0.pdf'))).toBe('invalid-path');
  });

  it('refuses symlinked files and symlinked folders, even ones that stay inside', () => {
    fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(root, 'escape.pdf'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    fs.symlinkSync(path.join(root, 'w2.pdf'), path.join(root, 'inside-link.pdf'));
    expect(codeOf(() => openGrantedPdf(root, 'escape.pdf'))).toBe('symlink');
    expect(codeOf(() => openGrantedPdf(root, 'linked-dir/secret.pdf'))).toBe('symlink');
    expect(codeOf(() => openGrantedPdf(root, 'inside-link.pdf'))).toBe('symlink');
  });

  it('refuses unsupported files: other extensions, fake PDFs, and folders', () => {
    expect(codeOf(() => openGrantedPdf(root, 'notes.txt'))).toBe('unsupported-type');
    expect(codeOf(() => openGrantedPdf(root, 'fake.pdf'))).toBe('unsupported-type');
    fs.mkdirSync(path.join(root, 'folder.pdf'));
    expect(codeOf(() => openGrantedPdf(root, 'folder.pdf'))).toBe('unsupported-type');
  });

  it('reports a missing file', () => {
    expect(codeOf(() => openGrantedPdf(root, 'gone.pdf'))).toBe('not-found');
  });

  it('refuses when the granted folder itself was replaced by a symlink', () => {
    fs.renameSync(root, `${root}-moved`);
    fs.symlinkSync(outside, root);
    expect(codeOf(() => openGrantedPdf(root, 'secret.pdf'))).toBe('grant-unavailable');
  });
});

describe('listGrantedPdfs', () => {
  it('lists real PDFs by extension, skipping hidden files, symlinks, and other types', () => {
    fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(root, 'escape.pdf'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    const listing = listGrantedPdfs(root);
    expect(listing.files.map((file) => file.relativePath)).toEqual(['fake.pdf', path.join('receipts', 'march.PDF'), 'w2.pdf']);
    expect(listing.truncated).toBe(false);
    expect(listing.files[0]!.size).toBe('not a pdf'.length);
  });

  it('stops at the entry limit and says so', () => {
    for (let i = 0; i < 5; i += 1) write(path.join(root, `extra-${i}.pdf`));
    const listing = listGrantedPdfs(root, { maxFiles: 3 });
    expect(listing.files).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  it('refuses when the granted folder is gone', () => {
    fs.rmSync(root, { recursive: true });
    expect(codeOf(() => listGrantedPdfs(root))).toBe('grant-unavailable');
  });
});
