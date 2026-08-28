// Ticket 14: the fixed control-key allowlist a remote (non-'raw-write')
// connection's 'input' frames are checked against. See
// docs/specs/session-persistence-and-remote-access.md, "Raw keystrokes from
// mobile are restricted to a fixed control-key set".
//
// Exact match only — never a prefix/startsWith check. A longer string that
// merely begins with an allowed sequence (e.g. an arrow key followed by
// injected bytes) must be refused whole, not truncated and partially
// accepted.
const ALLOWED_REMOTE_INPUT = new Set<string>([
  '\x03', // Ctrl-C
  '\r', // Enter (CR)
  '\n', // Enter (LF) — accept either line ending
  '\x1b', // Esc alone
  '\x1b[A', // Up
  '\x1b[B', // Down
  '\x1b[C', // Right
  '\x1b[D', // Left
]);

export function isAllowedRemoteInput(data: string): boolean {
  return ALLOWED_REMOTE_INPUT.has(data);
}
