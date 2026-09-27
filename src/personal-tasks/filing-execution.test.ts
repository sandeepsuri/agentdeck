// Issue #82: the move itself. Every check is repeated against the disk at
// effect time, a target is never replaced unless the owner approved that
// exact replacement, and an interrupted move is reconciled from the disk.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTextPdf } from '../test-fixtures/pdf.js';
import { moveGrantedPdf, reconcileMove, type FilingMoveItem } from './filing-execution.js';
import { fingerprintGrantedFile } from './folder-grant.js';

const POWER = buildTextPdf(['City Power & Light', 'March 2026']);
const OLD = buildTextPdf(['an older bill']);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-filing-exec-')));
  root = path.join(base, 'Inbox');
  fs.mkdirSync(path.join(root, 'Bills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'power.pdf'), POWER);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const at = (relative: string) => path.join(root, ...relative.split('/'));
const item = (overrides: Partial<FilingMoveItem> = {}): FilingMoveItem => ({
  source: 'power.pdf', sourceSha256: sha(POWER), target: 'Bills/Power 2026-03.pdf', overwrite: false, ...overrides,
});

describe('moveGrantedPdf', () => {
  it('moves the file, creating missing folders, and says so', () => {
    let effects = 0;
    const outcome = moveGrantedPdf(root, item({ target: 'Bills/Power/Power 2026-03.pdf' }), { beforeEffect: () => { effects += 1; } });
    expect(outcome).toEqual({ state: 'moved', replaced: false });
    expect(effects).toBe(1);
    expect(fs.existsSync(at('power.pdf'))).toBe(false);
    expect(fs.readFileSync(at('Bills/Power/Power 2026-03.pdf'))).toEqual(POWER);
  });

  it('renames a file whose new name differs only by case', () => {
    expect(moveGrantedPdf(root, item({ target: 'Power.pdf' }))).toEqual({ state: 'moved', replaced: false });
    expect(fs.readdirSync(root)).toContain('Power.pdf');
    expect(fs.readdirSync(root)).not.toContain('power.pdf');
  });

  it('never claims to move a file onto another hard link of itself', () => {
    fs.linkSync(at('power.pdf'), at('Bills/Power 2026-03.pdf'));
    let effects = 0;
    const outcome = moveGrantedPdf(root, item({ overwrite: true, targetSha256: sha(POWER) }), { beforeEffect: () => { effects += 1; } });
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringMatching(/another link/) });
    expect(effects).toBe(0);
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });

  it('refuses a source that changed after the proposal, before any effect', () => {
    fs.writeFileSync(at('power.pdf'), OLD);
    let effects = 0;
    const outcome = moveGrantedPdf(root, item(), { beforeEffect: () => { effects += 1; } });
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed since/) });
    expect(effects).toBe(0);
    expect(fs.readFileSync(at('power.pdf'))).toEqual(OLD);
  });

  it('refuses a source that is gone', () => {
    fs.rmSync(at('power.pdf'));
    expect(moveGrantedPdf(root, item())).toMatchObject({ state: 'failed', reason: expect.stringMatching(/no longer/) });
  });

  it('never follows a symlinked source or destination', () => {
    const outside = path.join(base, 'Outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, at('Bills/Linked'));
    expect(moveGrantedPdf(root, item({ target: 'Bills/Linked/Power.pdf' }))).toMatchObject({ state: 'failed', reason: expect.stringMatching(/link/i) });
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.renameSync(at('power.pdf'), path.join(outside, 'real.pdf'));
    fs.symlinkSync(path.join(outside, 'real.pdf'), at('power.pdf'));
    expect(moveGrantedPdf(root, item())).toMatchObject({ state: 'failed', reason: expect.stringMatching(/link/i) });
    expect(fs.existsSync(at('Bills/Power 2026-03.pdf'))).toBe(false);
  });

  it('refuses a granted folder that was swapped for a link', () => {
    fs.renameSync(root, `${root}-real`);
    fs.symlinkSync(`${root}-real`, root);
    expect(moveGrantedPdf(root, item())).toMatchObject({ state: 'failed', reason: expect.stringMatching(/granted folder/) });
    expect(fs.existsSync(path.join(`${root}-real`, 'power.pdf'))).toBe(true);
  });

  it('never replaces an existing target that was not approved for replacement', () => {
    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD);
    const outcome = moveGrantedPdf(root, item());
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringMatching(/already has this name/) });
    expect(fs.readFileSync(at('Bills/Power 2026-03.pdf'))).toEqual(OLD);
    expect(fs.readFileSync(at('power.pdf'))).toEqual(POWER);
  });

  it('refuses a target that appears between the checks and the move, without replacing it', () => {
    const outcome = moveGrantedPdf(root, item(), { beforeEffect: () => fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD) });
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringMatching(/appeared/) });
    expect(fs.readFileSync(at('Bills/Power 2026-03.pdf'))).toEqual(OLD);
    expect(fs.readFileSync(at('power.pdf'))).toEqual(POWER);
  });

  it('replaces an approved target only while it still holds the content the owner saw', () => {
    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD);
    const approved = item({ overwrite: true, targetSha256: sha(OLD) });

    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), buildTextPdf(['edited since']));
    expect(moveGrantedPdf(root, approved)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed since you approved/) });
    expect(fs.existsSync(at('power.pdf'))).toBe(true);

    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD);
    expect(moveGrantedPdf(root, approved)).toEqual({ state: 'moved', replaced: true });
    expect(fs.readFileSync(at('Bills/Power 2026-03.pdf'))).toEqual(POWER);
    expect(fs.existsSync(at('power.pdf'))).toBe(false);
  });

  it('refuses a target that is not a file', () => {
    fs.mkdirSync(at('Bills/Power 2026-03.pdf'));
    expect(moveGrantedPdf(root, item({ overwrite: true, targetSha256: sha(OLD) }))).toMatchObject({ state: 'failed' });
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });

  it('refuses invalid targets even if they reached the executor', () => {
    for (const target of ['../escape.pdf', 'Bills/../../escape.pdf', '/tmp/x.pdf', '.hidden/x.pdf', 'Bills/x.txt']) {
      expect(moveGrantedPdf(root, item({ target })), target).toMatchObject({ state: 'failed' });
    }
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });
});

describe('reconcileMove', () => {
  it('confirms a move that finished', () => {
    moveGrantedPdf(root, item());
    expect(reconcileMove(root, item())).toEqual({ state: 'moved' });
  });

  it('finishes a move interrupted between link and unlink', () => {
    fs.linkSync(at('power.pdf'), at('Bills/Power 2026-03.pdf'));
    expect(reconcileMove(root, item())).toEqual({ state: 'moved' });
    expect(fs.existsSync(at('power.pdf'))).toBe(false);
    expect(fs.readFileSync(at('Bills/Power 2026-03.pdf'))).toEqual(POWER);
  });

  it('never deletes the only copy after a case-only rename finished', () => {
    const renamed = item({ target: 'Power.pdf' });
    moveGrantedPdf(root, renamed);
    expect(reconcileMove(root, renamed)).toEqual({ state: 'moved' });
    expect(fs.readFileSync(at('Power.pdf'))).toEqual(POWER);
  });

  it('reports a move that never happened as not moved', () => {
    expect(reconcileMove(root, item())).toMatchObject({ state: 'failed', reason: expect.stringMatching(/left where it was/) });
    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD);
    expect(reconcileMove(root, item({ overwrite: true, targetSha256: sha(OLD) }))).toMatchObject({ state: 'failed' });
  });

  it('reports anything else as uncertain rather than guessing', () => {
    fs.writeFileSync(at('Bills/Power 2026-03.pdf'), OLD);
    expect(reconcileMove(root, item())).toMatchObject({ state: 'uncertain' });
    fs.rmSync(at('power.pdf'));
    expect(reconcileMove(root, item())).toMatchObject({ state: 'uncertain' });
  });
});

describe('fingerprintGrantedFile', () => {
  it('hashes a granted file without following links', () => {
    expect(fingerprintGrantedFile(root, 'power.pdf', 1024 * 1024)).toMatchObject({ sha256: sha(POWER) });
    fs.symlinkSync(at('power.pdf'), at('Bills/alias.pdf'));
    expect(() => fingerprintGrantedFile(root, 'Bills/alias.pdf', 1024 * 1024)).toThrow(/link/i);
  });
});
