import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFilingPlan, filingPlanDigest, inspectDestination, validateDestination, validateFileName, type FilingRequest,
} from './filing-plan.js';

const PDF = '%PDF-1.4\n%%EOF\n';
let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-filing-plan-')));
  root = path.join(base, 'Inbox');
  fs.mkdirSync(path.join(root, 'Bills'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(root, 'scan1.pdf'), PDF);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('validateFileName', () => {
  it('accepts a plain PDF name', () => {
    expect(validateFileName('2026-03 Power bill.pdf')).toBe('2026-03 Power bill.pdf');
    expect(validateFileName('Cafe\u0301.PDF')).toBe('Café.PDF');
  });

  it.each([
    ['../escape.pdf', /may not contain/],
    ['Bills/x.pdf', /may not contain/],
    ['a:b.pdf', /may not contain/],
    ['.hidden.pdf', /may not start with a dot/],
    ['..', /not a file name/],
    ['notes.txt', /must end in .pdf/],
    ['.pdf', /dot/],
    ['invoice\u202efdp.exe.pdf', /invisible/],
    ['x\u0000.pdf', /control/],
    [' spaced.pdf', /space/],
    [`${'a'.repeat(130)}.pdf`, /longer than/],
    [42, /must be text/],
  ])('refuses %j', (name, message) => {
    expect(() => validateFileName(name)).toThrowError(message);
  });
});

describe('validateDestination', () => {
  it('normalizes a relative folder', () => {
    expect(validateDestination('')).toBe('');
    expect(validateDestination('Bills/2026/')).toBe('Bills/2026');
  });

  it.each([
    ['/Users/owner/Desktop', /inside the granted folder/],
    ['~/Desktop', /inside the granted folder/],
    ['../outside', /not a folder name/],
    ['Bills/../../outside', /not a folder name/],
    ['.ssh', /dot/],
    ['a/b/c/d/e', /at most 4/],
    ['Bills\\..\\x', /may not contain/],
  ])('refuses %j', (destination, message) => {
    expect(() => validateDestination(destination)).toThrowError(message);
  });
});

describe('inspectDestination', () => {
  it('reports whether a destination exists without creating it', () => {
    expect(inspectDestination(root, 'Bills')).toEqual({ exists: true });
    expect(inspectDestination(root, 'Bills/2026')).toEqual({ exists: false });
    expect(fs.existsSync(path.join(root, 'Bills', '2026'))).toBe(false);
  });

  it('refuses a folder link, even one that points inside', () => {
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'Escape'));
    fs.symlinkSync(path.join(root, 'Bills'), path.join(root, 'Alias'));
    expect(() => inspectDestination(root, 'Escape')).toThrowError(/link/);
    expect(() => inspectDestination(root, 'Alias/2026')).toThrowError(/link/);
  });

  it('refuses a destination that runs through a file', () => {
    expect(() => inspectDestination(root, 'scan1.pdf/x')).toThrowError(/is a file/);
  });
});

describe('buildFilingPlan', () => {
  const sha = (n: number) => n.toString(16).padStart(64, '0');

  it('computes overwrite, duplicate, same-target, new-folder and unchanged warnings', () => {
    fs.writeFileSync(path.join(root, 'Bills', 'taken.pdf'), '%PDF-1.4\nother\n');
    const sources = [
      { path: 'a.pdf', sha256: sha(1) },
      { path: 'b.pdf', sha256: sha(2) },
      { path: 'c.pdf', sha256: sha(2) },
      { path: 'scan1.pdf', sha256: sha(3) },
      { path: 'd.pdf', sha256: sha(4) },
      { path: 'e.pdf', sha256: sha(5) },
    ];
    const requests = new Map<string, FilingRequest>([
      ['a.pdf', { newName: 'taken.pdf', destination: 'Bills' }],
      ['b.pdf', { newName: 'Same.pdf', destination: 'Bills/2026' }],
      ['c.pdf', { newName: 'same.pdf', destination: 'Bills/2026' }],
      ['scan1.pdf', { newName: 'SCAN1.pdf', destination: '' }],
      ['e.pdf', { newName: 'x.pdf', destination: '../outside' }],
    ]);
    const plan = buildFilingPlan(root, sources, requests);
    const kinds = Object.fromEntries(plan.entries.map((entry) => [entry.source, entry.warnings.map((warning) => warning.kind)]));
    expect(kinds).toEqual({
      'a.pdf': ['overwrite'],
      'b.pdf': ['new-folder', 'same-target', 'duplicate-content'],
      'c.pdf': ['new-folder', 'same-target', 'duplicate-content'],
      'scan1.pdf': ['unchanged'],
    });
    expect(plan.entries.find((entry) => entry.source === 'b.pdf')).toMatchObject({ target: 'Bills/2026/Same.pdf', sourceSha256: sha(2) });
    expect(plan.unplanned).toEqual([
      { path: 'd.pdf', reason: expect.stringMatching(/No filing was proposed/) },
      { path: 'e.pdf', reason: expect.stringMatching(/refused/) },
    ]);
  });

  it('marks a target that already holds identical bytes as already filed', () => {
    const bytes = '%PDF-1.4\nsame\n';
    fs.writeFileSync(path.join(root, 'Bills', 'copy.pdf'), bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const plan = buildFilingPlan(root, [{ path: 'scan1.pdf', sha256: digest }], new Map([['scan1.pdf', { newName: 'copy.pdf', destination: 'Bills' }]]));
    expect(plan.entries[0]!.warnings.map((warning) => warning.kind)).toEqual(['already-filed']);
  });

  it('refuses a target that is a folder or a link', () => {
    fs.mkdirSync(path.join(root, 'Bills', 'dir.pdf'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'Bills', 'link.pdf'));
    const plan = buildFilingPlan(root, [{ path: 'a.pdf', sha256: sha(1) }, { path: 'b.pdf', sha256: sha(2) }], new Map([
      ['a.pdf', { newName: 'dir.pdf', destination: 'Bills' }],
      ['b.pdf', { newName: 'link.pdf', destination: 'Bills' }],
    ]));
    expect(plan.entries).toEqual([]);
    expect(plan.unplanned.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/other than a file/), expect.stringMatching(/other than a file/),
    ]);
  });

  it('never creates or moves anything', () => {
    const before = fs.readdirSync(root, { recursive: true }).sort();
    buildFilingPlan(root, [{ path: 'scan1.pdf', sha256: sha(3) }], new Map([['scan1.pdf', { newName: 'n.pdf', destination: 'New/Deep' }]]));
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });
});

describe('filingPlanDigest', () => {
  const entry = (source: string, newName: string) => ({
    source, sourceSha256: 'a'.repeat(64), newName, destination: 'Bills', target: `Bills/${newName}`, warnings: [],
  });

  it('is independent of entry order and changes with any typed parameter', () => {
    const a = entry('a.pdf', 'A.pdf');
    const b = entry('b.pdf', 'B.pdf');
    expect(filingPlanDigest('g1', [a, b])).toBe(filingPlanDigest('g1', [b, a]));
    expect(filingPlanDigest('g1', [a, b])).not.toBe(filingPlanDigest('g2', [a, b]));
    expect(filingPlanDigest('g1', [a, b])).not.toBe(filingPlanDigest('g1', [a, entry('b.pdf', 'B2.pdf')]));
    expect(filingPlanDigest('g1', [a])).not.toBe(filingPlanDigest('g1', [{ ...a, sourceSha256: 'b'.repeat(64) }]));
  });
});
