import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAgentProcesses, parseLsofCwd, parsePs } from './ps.js';

const fixture = fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures/ps-agents.txt'),
  'utf8',
);

describe('parsePs', () => {
  it('parses the captured macOS ps format without losing commands or lstart', () => {
    const rows = parsePs(fixture);
    const launcher = rows.find((row) => row.pid === 91788);
    expect(launcher).toMatchObject({
      ppid: 89257,
      tty: 'ttys008',
      state: 'S+',
      cpu: 0,
      command: 'node /Users/dev/.nvm/versions/node/v24.14.0/bin/codex',
    });
    expect(launcher?.startEpoch).toBe(Math.floor(new Date('Thu Jul 16 17:39:00 2026').getTime() / 1000));
  });
});

describe('findAgentProcesses', () => {
  it('keeps only interactive launcher processes from the captured fixture', () => {
    const candidates = findAgentProcesses(parsePs(fixture), new Set());
    expect(candidates.map((candidate) => candidate.pid)).toEqual([91788, 48702, 91696, 91603]);
    expect(candidates.map((candidate) => candidate.agent)).toEqual(['codex', 'claude', 'codex', 'codex']);
    expect(candidates.every((candidate) => candidate.tty.startsWith('ttys'))).toBe(true);
  });

  it('drops binary children when their launcher parent also matches and excludes managed pids', () => {
    const rows = parsePs(fixture);
    const candidates = findAgentProcesses(rows, new Set([91788, 48702]));
    expect(candidates.map((candidate) => candidate.pid)).toEqual([91696, 91603]);
    expect(candidates.some((candidate) => candidate.pid === 91789)).toBe(false);
  });
});

describe('parseLsofCwd', () => {
  it('extracts the cwd n-record and tolerates missing output', () => {
    const output = fs.readFileSync(
      path.resolve(import.meta.dirname, 'fixtures/lsof-cwd-example.txt'),
      'utf8',
    );
    expect(parseLsofCwd(output)).toBe('/Users/dev/projects/example-app');
    expect(parseLsofCwd('p123\nfcwd\n')).toBeUndefined();
  });
});
