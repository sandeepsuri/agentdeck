// remote-input.ts: exact-match allowlist for raw input frames arriving on a
// connection that lacks the 'raw-write' capability (ticket 14). This is a
// security boundary — every rejection case here is adversarial on purpose.
import { describe, expect, it } from 'vitest';
import { containsDisallowedControlBytes, isAllowedRemoteInput } from './remote-input.js';

describe('isAllowedRemoteInput', () => {
  it('allows Ctrl-C', () => {
    expect(isAllowedRemoteInput('\x03')).toBe(true);
  });

  it('allows both Enter encodings', () => {
    expect(isAllowedRemoteInput('\r')).toBe(true);
    expect(isAllowedRemoteInput('\n')).toBe(true);
  });

  it('allows Esc alone', () => {
    expect(isAllowedRemoteInput('\x1b')).toBe(true);
  });

  it('allows all four arrow-key CSI sequences', () => {
    expect(isAllowedRemoteInput('\x1b[A')).toBe(true); // up
    expect(isAllowedRemoteInput('\x1b[B')).toBe(true); // down
    expect(isAllowedRemoteInput('\x1b[C')).toBe(true); // right
    expect(isAllowedRemoteInput('\x1b[D')).toBe(true); // left
  });

  it('rejects an arrow sequence with extra bytes appended (superset, not exact match)', () => {
    expect(isAllowedRemoteInput('\x1b[Aextra')).toBe(false);
  });

  it('rejects Esc followed by other bytes (not the bare Esc sequence)', () => {
    expect(isAllowedRemoteInput('\x1bfoo')).toBe(false);
    expect(isAllowedRemoteInput('\x1b[')).toBe(false);
    expect(isAllowedRemoteInput('\x1b[Z')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isAllowedRemoteInput('')).toBe(false);
  });

  it('rejects arbitrary printable text', () => {
    expect(isAllowedRemoteInput('rm -rf /')).toBe(false);
    expect(isAllowedRemoteInput('a')).toBe(false);
    expect(isAllowedRemoteInput(' ')).toBe(false);
  });

  it('rejects a long string even when it contains an allowed sequence as a substring', () => {
    const long = 'a'.repeat(1000) + '\x03' + 'b'.repeat(1000);
    expect(isAllowedRemoteInput(long)).toBe(false);
    expect(long.length).toBeGreaterThan(1999);
  });

  it('rejects a 2000-character arbitrary string', () => {
    expect(isAllowedRemoteInput('x'.repeat(2000))).toBe(false);
  });

  it('rejects a multi-key combination that is not one of the fixed sequences', () => {
    expect(isAllowedRemoteInput('\x03\r')).toBe(false); // Ctrl-C then Enter, sent as one frame
    expect(isAllowedRemoteInput('\x1b[A\x1b[B')).toBe(false); // up then down
  });

  it('rejects other common control bytes not in the allowlist', () => {
    expect(isAllowedRemoteInput('\x04')).toBe(false); // Ctrl-D
    expect(isAllowedRemoteInput('\t')).toBe(false); // Tab
    expect(isAllowedRemoteInput('\x7f')).toBe(false); // Backspace/DEL
  });
});

// Code-review finding: POST /api/sessions/:id/send (routes.ts) writes its
// `text` verbatim to the PTY, and ticket 05 made that route reachable by an
// authenticated remote connection — this predicate is what closes the
// resulting bypass of the control-key restriction above.
describe('containsDisallowedControlBytes', () => {
  it('allows ordinary human-authored text', () => {
    expect(containsDisallowedControlBytes('hello, please continue')).toBe(false);
  });

  it('allows newlines and tabs (legitimate message formatting)', () => {
    expect(containsDisallowedControlBytes('line one\nline two\tindented')).toBe(false);
  });

  it('flags an embedded Ctrl-C', () => {
    expect(containsDisallowedControlBytes('please continue\x03')).toBe(true);
  });

  it('flags an embedded Esc/CSI sequence smuggled inside otherwise-normal text', () => {
    expect(containsDisallowedControlBytes('looks fine\x1b[Anow move up')).toBe(true);
  });

  it('flags a bare Esc anywhere in the string', () => {
    expect(containsDisallowedControlBytes('a\x1bb')).toBe(true);
  });

  it('flags DEL', () => {
    expect(containsDisallowedControlBytes('a\x7fb')).toBe(true);
  });

  it('flags other C0 control bytes (e.g. Ctrl-D)', () => {
    expect(containsDisallowedControlBytes('a\x04b')).toBe(true);
  });

  it('allows an empty string', () => {
    expect(containsDisallowedControlBytes('')).toBe(false);
  });
});
