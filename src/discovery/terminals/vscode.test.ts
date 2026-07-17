import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { VsCodeAdapter, VsCodeBridge } from './vscode.js';

function fakeSocket() {
  return { send: vi.fn() } as unknown as WebSocket;
}

describe('VS Code terminal bridge', () => {
  it('maps registered shell processes to ttys and exact terminal refs', async () => {
    const bridge = new VsCodeBridge();
    const ws = fakeSocket();
    bridge.register(ws, 'window-1', [
      { id: 'term-a', name: 'Claude', processId: 101 },
      { id: 'term-b', name: 'Codex', processId: 102 },
    ]);
    const adapter = new VsCodeAdapter(bridge, async (pid) => `ttys${pid}`, 0);

    expect(await adapter.listTtys()).toEqual([
      { tty: 'ttys101', windowId: 'window-1', tabId: 'term-a', title: 'Claude' },
      { tty: 'ttys102', windowId: 'window-1', tabId: 'term-b', title: 'Codex' },
    ]);
    expect(bridge.status()).toEqual({ connected: true, windows: 1, terminals: 2 });
  });

  it('acknowledges focus and paste-then-submit actions for one terminal', async () => {
    const bridge = new VsCodeBridge();
    const ws = fakeSocket();
    const sent: Array<Record<string, unknown>> = [];
    (ws.send as unknown as ReturnType<typeof vi.fn>).mockImplementation((raw: string) => {
      const frame = JSON.parse(raw) as { requestId: string } & Record<string, unknown>;
      sent.push(frame);
      queueMicrotask(() => bridge.result(ws, frame.requestId, true));
    });
    bridge.register(ws, 'window-1', [{ id: 'term-a', name: 'Agent', processId: 101 }]);
    const adapter = new VsCodeAdapter(bridge, async () => 'ttys001', 0);
    const ref = { windowId: 'window-1', tabId: 'term-a' };

    await adapter.focus(ref);
    await adapter.sendText(ref, 'run tests');

    expect(sent.map(({ action, text }) => ({ action, text }))).toEqual([
      { action: 'focus', text: undefined },
      { action: 'send', text: 'run tests' },
      { action: 'send', text: '' },
    ]);
  });

  it('removes disconnected windows and rejects pending actions', async () => {
    const bridge = new VsCodeBridge();
    const ws = fakeSocket();
    bridge.register(ws, 'window-1', [{ id: 'term-a', name: 'Agent', processId: 101 }]);
    const pending = bridge.action('window-1', 'term-a', 'focus');
    bridge.disconnect(ws);
    await expect(pending).rejects.toThrow(/disconnected/i);
    expect(bridge.status()).toEqual({ connected: false, windows: 0, terminals: 0 });
  });
});
