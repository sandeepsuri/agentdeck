// WS frame protocol. Shared between the server (src/server/ws.ts) and the
// UI (src/ui/components/Terminal.tsx).
import type { AgentMessage, Session } from './types.js';

export type ClientFrame =
  | { t: 'attach'; sessionId: string }
  | { t: 'input'; data: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'detach' };

export type ServerFrame =
  | { t: 'replay'; data: string }
  | { t: 'output'; data: string }
  | { t: 'session_update'; session: Session }
  | { t: 'session_removed'; sessionId: string }
  | { t: 'agent_event'; event: AgentMessage };

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
      return typeof f.sessionId === 'string' ? { t: 'attach', sessionId: f.sessionId } : null;
    case 'input':
      return typeof f.data === 'string' ? { t: 'input', data: f.data } : null;
    case 'resize':
      return typeof f.cols === 'number' && typeof f.rows === 'number' &&
        Number.isInteger(f.cols) && Number.isInteger(f.rows) && f.cols > 0 && f.rows > 0
        ? { t: 'resize', cols: f.cols, rows: f.rows }
        : null;
    case 'detach':
      return { t: 'detach' };
    default:
      return null;
  }
}
