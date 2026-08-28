// Ticket 14: the fixed control-key allowlist a remote (non-'raw-write')
// connection's 'input' frames are checked against. See
// docs/specs/session-persistence-and-remote-access.md, "Raw keystrokes from
// mobile are restricted to a fixed control-key set".
//
// Exact match only — never a prefix/startsWith check. A longer string that
// merely begins with an allowed sequence (e.g. an arrow key followed by
// injected bytes) must be refused whole, not truncated and partially
// accepted.
//
// Built from protocol.ts's CONTROL_KEYS (the same list ControlKeys.tsx
// renders buttons for) plus '\n', accepted alongside '\r' for Enter since a
// raw WS client (not just the button component) might send either line
// ending — this one extra byte is server-side leniency, not a second
// button, so it isn't part of the shared button-definition list.
import { CONTROL_KEYS } from '../protocol.js';

const ALLOWED_REMOTE_INPUT = new Set<string>([...CONTROL_KEYS.map((key) => key.data), '\n']);

export function isAllowedRemoteInput(data: string): boolean {
  return ALLOWED_REMOTE_INPUT.has(data);
}

/**
 * Ticket 14 follow-up (code review finding): the fixed control-key set is
 * enforced on the WS 'input' frame (isAllowedRemoteInput above), but
 * POST /api/sessions/:id/send (routes.ts) writes its `text` verbatim to the
 * PTY too, unfiltered — and ticket 05 made that route reachable by an
 * authenticated remote connection. Without this check, a remote client
 * could smuggle Ctrl-C/Esc/other raw control bytes through the free-text
 * composer, defeating the control-key restriction through a different
 * door than the one that was actually locked. This is deliberately looser
 * than the WS allowlist: `text` is a human-authored message that may
 * legitimately contain newlines/tabs for formatting, so only C0 control
 * bytes other than \n and \t (and DEL) are disallowed, not every
 * non-printable character — the WS path remains the only way to send an
 * *allowed* control key; this just closes the bypass, it doesn't reopen
 * the WS allowlist here.
 */
export function containsDisallowedControlBytes(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7f) return true; // DEL
    if (code < 0x20 && code !== 0x0a && code !== 0x09) return true; // C0 except \n, \t
  }
  return false;
}
