import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutableInPath } from './executable.js';

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
