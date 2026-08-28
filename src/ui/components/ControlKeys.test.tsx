// @vitest-environment jsdom
// ControlKeys (ticket 14): a standalone control-key pad, rendered here in a
// bare DOM with a fake WebSocket-shaped object — not inside any real
// workspace tree (ticket 13 owns MobileWorkspace.tsx and will place this
// component later). Each button must send the exact frame shape the desktop
// composer already sends: {t:'input', sessionId, data}.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ControlKeys } from './ControlKeys.js';

beforeAll(() => {
  // Required by React 18's act() outside a test-runner integration
  // (@testing-library/react normally sets this) — see
  // https://react.dev/warnings/react-dom-test-utils.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Minimal WebSocket-shaped fake: only what ControlKeys touches. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  send = vi.fn();
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ws: unknown, sessionId = 'session-1') {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<ControlKeys sessionId={sessionId} ws={ws as WebSocket} />);
  });
  return container;
}

afterEach(() => {
  if (root && container) {
    act(() => { root!.unmount(); });
  }
  if (container) {
    container.remove();
  }
  container = null;
  root = null;
});

function clickButton(host: HTMLElement, name: string) {
  const button = Array.from(host.querySelectorAll('button'))
    .find((b) => b.textContent === name || b.getAttribute('aria-label') === name);
  if (!button) throw new Error(`no button found for ${name}`);
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('ControlKeys', () => {
  it('sends Ctrl-C as {t:"input", sessionId, data:"\\x03"}', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws, 'session-1');
    clickButton(host, 'Ctrl-C');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ t: 'input', sessionId: 'session-1', data: '\x03' }));
  });

  it('sends Esc as {t:"input", sessionId, data:"\\x1b"}', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws, 'session-1');
    clickButton(host, 'Esc');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ t: 'input', sessionId: 'session-1', data: '\x1b' }));
  });

  it('sends Enter as {t:"input", sessionId, data:"\\r"}', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws, 'session-1');
    clickButton(host, 'Enter');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ t: 'input', sessionId: 'session-1', data: '\r' }));
  });

  it('sends the four arrow keys as their exact CSI byte sequences', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws, 'session-2');
    clickButton(host, '↑');
    clickButton(host, '↓');
    clickButton(host, '←');
    clickButton(host, '→');
    expect(ws.send.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify({ t: 'input', sessionId: 'session-2', data: '\x1b[A' }),
      JSON.stringify({ t: 'input', sessionId: 'session-2', data: '\x1b[B' }),
      JSON.stringify({ t: 'input', sessionId: 'session-2', data: '\x1b[D' }),
      JSON.stringify({ t: 'input', sessionId: 'session-2', data: '\x1b[C' }),
    ]);
  });

  it('does not throw when ws is null', () => {
    const host = mount(null, 'session-1');
    expect(() => clickButton(host, 'Ctrl-C')).not.toThrow();
  });

  it('does not throw, and does not call send, when ws is closed', () => {
    const ws = new FakeWebSocket();
    ws.readyState = FakeWebSocket.CLOSED;
    const host = mount(ws, 'session-1');
    expect(() => clickButton(host, 'Ctrl-C')).not.toThrow();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
