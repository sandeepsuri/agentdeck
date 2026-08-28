import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSummary, writeSummary, summaryFilePath } from './summary.js';

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-summary-'));
});

afterEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe('summary file storage', () => {
  it('returns undefined when no summary has been written yet', async () => {
    expect(await readSummary(sessionsDir, 'sess-1')).toBeUndefined();
  });

  it('writes and reads back a summary at sessions/<id>/summary.md', async () => {
    await writeSummary(sessionsDir, 'sess-1', 'The agent refactored the parser and left tests green.');
    expect(await readSummary(sessionsDir, 'sess-1')).toBe('The agent refactored the parser and left tests green.');
    expect(fs.existsSync(summaryFilePath(sessionsDir, 'sess-1'))).toBe(true);
    expect(summaryFilePath(sessionsDir, 'sess-1')).toBe(path.join(sessionsDir, 'sess-1', 'summary.md'));
  });

  it('creates the per-session directory if it does not already exist', async () => {
    await writeSummary(sessionsDir, 'brand-new', 'summary text');
    expect(fs.existsSync(path.join(sessionsDir, 'brand-new'))).toBe(true);
  });

  it('regenerating overwrites the previous summary in place', async () => {
    await writeSummary(sessionsDir, 'sess-1', 'first summary');
    await writeSummary(sessionsDir, 'sess-1', 'second summary, replacing the first');
    expect(await readSummary(sessionsDir, 'sess-1')).toBe('second summary, replacing the first');
  });
});
