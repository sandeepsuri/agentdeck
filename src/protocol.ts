// WS frame protocol. Shared between the server (src/server/ws.ts) and the
// UI (src/ui/components/Terminal.tsx).
import type { AgentMessage, CompanionSnapshot, Session } from './types.js';

const MAX_ID_LENGTH = 200;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_ERROR_LENGTH = 4096;
const MAX_TERMINAL_DIMENSION = 1000;

export interface VsCodeTerminalFrame {
  id: string;
  name: string;
  processId: number;
}

export type ClientFrame =
  | { t: 'attach'; sessionId: string }
  | { t: 'input'; data: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'detach' }
  | { t: 'vscode_register'; windowId: string; terminals: VsCodeTerminalFrame[] }
  | { t: 'vscode_terminals'; windowId: string; terminals: VsCodeTerminalFrame[] }
  | { t: 'vscode_result'; requestId: string; ok: boolean; error?: string }
  | { t: 'ui_presence'; visible: boolean };

export type ServerFrame =
  | { t: 'replay'; data: string }
  | { t: 'output'; data: string }
  | { t: 'session_update'; session: Session }
  | { t: 'session_removed'; sessionId: string }
  | { t: 'agent_event'; event: AgentMessage }
  | { t: 'companion_snapshot'; snapshot: CompanionSnapshot }
  | { t: 'ui_presence'; visible: boolean }
  | { t: 'vscode_action'; requestId: string; terminalId: string; action: 'send' | 'focus'; text?: string };

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
        ? { t: 'input', data: f.data }
        : null;
    case 'resize':
      return typeof f.cols === 'number' && typeof f.rows === 'number' &&
        Number.isInteger(f.cols) && Number.isInteger(f.rows)
        && f.cols > 0 && f.cols <= MAX_TERMINAL_DIMENSION
        && f.rows > 0 && f.rows <= MAX_TERMINAL_DIMENSION
        ? { t: 'resize', cols: f.cols, rows: f.rows }
        : null;
    case 'detach':
      return { t: 'detach' };
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
    default:
      return null;
  }
}
