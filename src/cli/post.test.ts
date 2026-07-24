import { describe, expect, it } from 'vitest';
import { parsePostArgs } from './post.js';

describe('parsePostArgs', () => {
  it('accepts an explicit progress percentage', () => {
    expect(parsePostArgs([
      '--event', 'progress', '--agent', 'codex:test', '--progress', '48.5', '-m', 'Halfway',
    ], '/repo')).toMatchObject({
      agent: 'codex:test', repo: '/repo', event: 'progress', progress: 48.5, message: 'Halfway',
    });
  });

  it('rejects progress outside 0 through 100', () => {
    expect(() => parsePostArgs(['--event', 'progress', '--progress', '101'], '/repo'))
      .toThrow('--progress must be a number from 0 to 100');
    expect(() => parsePostArgs(['--event', 'progress', '--progress', 'nope'], '/repo'))
      .toThrow('--progress must be a number from 0 to 100');
  });
});
