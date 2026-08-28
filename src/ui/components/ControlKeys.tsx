// Ticket 14: a fixed control-key pad for mobile. Sends the same WS 'input'
// frame shape the desktop composer already sends (Terminal.tsx's send()),
// just with a fixed byte sequence per button instead of arbitrary typed
// input. Standalone and self-contained on purpose — MobileWorkspace.tsx
// places this component in its fixed slot.
import { CONTROL_KEYS, type ClientFrame } from '../../protocol.js';

interface Props {
  sessionId: string;
  ws: WebSocket | null;
}

export function ControlKeys({ sessionId, ws }: Props) {
  const send = (data: string) => {
    const frame: ClientFrame = { t: 'input', sessionId, data };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  return (
    <div className="control-keys" role="group" aria-label="Control keys">
      {CONTROL_KEYS.map(({ label, data }) => (
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
