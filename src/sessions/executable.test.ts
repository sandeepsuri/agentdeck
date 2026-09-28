import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { agentPath, findExecutableInPath } from './executable.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('findExecutableInPath', () => {
  it('returns the first executable match and ignores non-executable files', () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bin-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bin-'));
    tempDirs.push(first, second);
    fs.writeFileSync(path.join(first, 'codex'), 'not executable');
    fs.writeFileSync(path.join(second, 'codex'), '#!/bin/sh\n');
    fs.chmodSync(path.join(second, 'codex'), 0o755);

    expect(findExecutableInPath('codex', [first, second].join(path.delimiter)))
      .toBe(path.join(second, 'codex'));
    expect(findExecutableInPath('claude', [first, second].join(path.delimiter))).toBeUndefined();
  });
});

describe('agentPath', () => {
  it('lets a Node launcher script run under the minimal PATH a macOS app inherits', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bin-'));
    tempDirs.push(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env node\nconsole.log("codex ok")\n');
    fs.chmodSync(codex, 0o755);
    const minimal = '/usr/bin:/bin:/usr/sbin:/sbin';

    expect(() => execFileSync(codex, { env: { PATH: '/nonexistent' }, stdio: 'pipe' })).toThrow();
    expect(execFileSync(codex, { env: { PATH: agentPath(codex, minimal) }, encoding: 'utf8' })).toBe('codex ok\n');
  });

  it('puts the executable directory first, keeps the inherited PATH, and dedupes', () => {
    const result = agentPath('/opt/tools/bin/codex', '/usr/bin:/opt/tools/bin:/custom').split(path.delimiter);
    expect(result[0]).toBe('/opt/tools/bin');
    expect(result).toContain('/custom');
    expect(result).toContain('/opt/homebrew/bin');
    expect(new Set(result).size).toBe(result.length);
  });

  it('skips the directory of a bare command name', () => {
    expect(agentPath('codex', '/usr/bin').split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
  });
});
