// WS frame protocol. Shared between the server (src/server/ws.ts) and the
// UI (src/ui/components/Terminal.tsx).
import type { AgentMessage, CompanionSnapshot, Session } from './types.js';

const MAX_ID_LENGTH = 200;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_ERROR_LENGTH = 4096;

// Managed session terminal size is pinned for the life of the session (see
// docs/specs/session-persistence-and-remote-access.md, "Pinned 100×30 with
// no viewer resize authority"). PtyBackend spawns at this size and the
// client renders at this size; no viewer can change either.
export const TERMINAL_COLS = 100;
export const TERMINAL_ROWS = 30;

// Ticket 05: the tailnet access token's transport. Browsers cannot set
// custom headers on a WebSocket upgrade request, so the token travels as a
// query param there; REST requests carry it as a header instead. These live
// here (rather than in server/connection-trust.ts, which imports
// node:crypto) so the UI bundle can import them without pulling
// server-only code into the client — same reasoning as TERMINAL_COLS above.
// connection-trust.ts re-exports both for server-side callers.
export const TOKEN_QUERY_PARAM = 'token';
export const TOKEN_HEADER = 'x-agentdeck-token';

/**
 * Ticket 14: the fixed control-key set a remote (non-'raw-write')
 * connection may send, one WS 'input' frame per byte sequence. Shared
 * between src/ui/components/ControlKeys.tsx (the button labels) and
 * src/server/remote-input.ts (the server-side allowlist) so the two sides
 * can't drift — same reasoning as TOKEN_HEADER/TOKEN_QUERY_PARAM above.
 */
export interface ControlKeyDef {
  label: string;
  data: string;
}
export const CONTROL_KEYS: ControlKeyDef[] = [
  { label: 'Ctrl-C', data: '\x03' },
  { label: 'Esc', data: '\x1b' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Enter', data: '\r' },
];

export interface VsCodeTerminalFrame {
  id: string;
  name: string;
  processId: number;
}

/** Ticket 07: the same three decisions the REST /api/runs/:id/attention/:attentionId/{approve,deny,input} routes accept, over WS instead. */
export type RunAttentionResolveFrame =
  | { t: 'run_attention_resolve'; runId: string; attentionId: string; decision: 'approve' | 'deny' }
  | { t: 'run_attention_resolve'; runId: string; attentionId: string; decision: 'input'; value: string };

export type ClientFrame =
  | { t: 'attach'; sessionId: string }
  | { t: 'input'; sessionId: string; data: string }
  | { t: 'detach'; sessionId: string }
  | { t: 'vscode_register'; windowId: string; terminals: VsCodeTerminalFrame[] }
  | { t: 'vscode_terminals'; windowId: string; terminals: VsCodeTerminalFrame[] }
  | { t: 'vscode_result'; requestId: string; ok: boolean; error?: string }
  | { t: 'ui_presence'; visible: boolean }
  | RunAttentionResolveFrame;

export type ServerFrame =
  | { t: 'replay'; sessionId: string; data: string }
  | { t: 'output'; sessionId: string; data: string }
  | { t: 'session_update'; session: Session }
  | { t: 'session_removed'; sessionId: string }
  | { t: 'agent_event'; event: AgentMessage }
  | { t: 'companion_snapshot'; snapshot: CompanionSnapshot }
  | { t: 'ui_presence'; visible: boolean }
  | { t: 'vscode_action'; requestId: string; terminalId: string; action: 'send' | 'focus'; text?: string }
  // Mission Control tile preview: pushed to every socket (not just an attached
  // viewer) so grid tiles update without per-tile HTTP polling. `seed: true`
  // is a full-buffer replace sent once on connect; `seed: false` is an
  // incremental chunk to append client-side (see GridView.tsx).
  | { t: 'tile_preview'; sessionId: string; data: string; seed: boolean }
  // Ticket 13: sent instead of 'replay'/'output' to a 'remote'-classified
  // connection attached to a session — periodically re-rendered plain text
  // (LiveReflow, src/sessions/live-reflow.ts), never raw PTY bytes. `text`
  // is a full replace of the view, not an incremental chunk.
  | { t: 'reflow_text'; sessionId: string; text: string };

function parseVsCodeTerminals(value: unknown): VsCodeTerminalFrame[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const terminals: VsCodeTerminalFrame[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const terminal = item as Record<string, unknown>;
    if (typeof terminal.id !== 'string' || terminal.id.length > 200
      || typeof terminal.name !== 'string' || terminal.name.length > 500
      || typeof terminal.processId !== 'number' || !Number.isInteger(terminal.processId)
      || terminal.processId <= 0) return null;
    terminals.push({ id: terminal.id, name: terminal.name, processId: terminal.processId });
  }
  return terminals;
}

export function parseClientFrame(raw: string): ClientFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const f = msg as Record<string, unknown>;
  switch (f.t) {
    case 'attach':
      return typeof f.sessionId === 'string' && f.sessionId.length <= MAX_ID_LENGTH
        ? { t: 'attach', sessionId: f.sessionId }
        : null;
    case 'input':
      return typeof f.data === 'string' && f.data.length <= MAX_INPUT_LENGTH
        && typeof f.sessionId === 'string' && f.sessionId.length <= MAX_ID_LENGTH
        ? { t: 'input', sessionId: f.sessionId, data: f.data }
        : null;
    case 'detach':
      return typeof f.sessionId === 'string' && f.sessionId.length <= MAX_ID_LENGTH
        ? { t: 'detach', sessionId: f.sessionId }
        : null;
    case 'vscode_register':
    case 'vscode_terminals': {
      const terminals = parseVsCodeTerminals(f.terminals);
      return typeof f.windowId === 'string' && f.windowId.length <= 200 && terminals
        ? { t: f.t, windowId: f.windowId, terminals }
        : null;
    }
    case 'vscode_result':
      return typeof f.requestId === 'string' && f.requestId.length <= MAX_ID_LENGTH
        && typeof f.ok === 'boolean'
        && (f.error === undefined || (typeof f.error === 'string' && f.error.length <= MAX_ERROR_LENGTH))
        ? { t: 'vscode_result', requestId: f.requestId, ok: f.ok, ...(typeof f.error === 'string' ? { error: f.error } : {}) }
        : null;
    case 'ui_presence':
      return typeof f.visible === 'boolean' ? { t: 'ui_presence', visible: f.visible } : null;
    case 'run_attention_resolve': {
      if (typeof f.runId !== 'string' || f.runId.length === 0 || f.runId.length > MAX_ID_LENGTH) return null;
      if (typeof f.attentionId !== 'string' || f.attentionId.length === 0 || f.attentionId.length > MAX_ID_LENGTH) return null;
      if (f.decision === 'approve' || f.decision === 'deny') {
        return {
          t: 'run_attention_resolve', runId: f.runId, attentionId: f.attentionId, decision: f.decision,
        };
      }
      if (f.decision === 'input' && typeof f.value === 'string' && f.value.length > 0 && f.value.length <= MAX_INPUT_LENGTH) {
        return {
          t: 'run_attention_resolve', runId: f.runId, attentionId: f.attentionId, decision: 'input', value: f.value,
        };
      }
      return null;
    }
    default:
      return null;
  }
}
