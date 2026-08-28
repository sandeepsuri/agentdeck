// Ticket 14: a fixed control-key pad for mobile. Sends the same WS 'input'
// frame shape the desktop composer already sends (Terminal.tsx's send()),
// just with a fixed byte sequence per button instead of arbitrary typed
// input. Standalone and self-contained on purpose — ticket 13 owns
// MobileWorkspace.tsx and will place this component there later.
import type { ClientFrame } from '../../protocol.js';

interface Props {
  sessionId: string;
  ws: WebSocket | null;
}

const KEYS: { label: string; data: string }[] = [
  { label: 'Ctrl-C', data: '\x03' },
  { label: 'Esc', data: '\x1b' },
  { label: '↑', data: '\x1b[A' }, // up
  { label: '↓', data: '\x1b[B' }, // down
  { label: '←', data: '\x1b[D' }, // left
  { label: '→', data: '\x1b[C' }, // right
  { label: 'Enter', data: '\r' },
];

export function ControlKeys({ sessionId, ws }: Props) {
  const send = (data: string) => {
    const frame: ClientFrame = { t: 'input', sessionId, data };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  return (
    <div className="control-keys" role="group" aria-label="Control keys">
      {KEYS.map(({ label, data }) => (
        <button
          key={label}
          type="button"
          className="control-key"
          onClick={() => send(data)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
