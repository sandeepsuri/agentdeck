// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal.js';

const mock = vi.hoisted(() => ({ refresh: vi.fn(), opened: vi.fn(), disposed: vi.fn() }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { theme: {} };
    open = mock.opened;
    refresh = mock.refresh;
    dispose = mock.disposed;
    onData = () => ({ dispose: vi.fn() });
    reset = vi.fn();
    write = vi.fn();
  },
}));
vi.mock('../theme.js', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { vi.unstubAllGlobals(); mock.refresh.mockClear(); mock.opened.mockClear(); mock.disposed.mockClear(); });

describe('managed terminal visibility', () => {
  it('repaints the same terminal when a hidden session becomes active again', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN, send: vi.fn() }) as unknown as WebSocket;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Terminal active={false} sessionId="session-1" ws={socket} />));
      expect(mock.opened).toHaveBeenCalledTimes(1);
      expect(mock.refresh).not.toHaveBeenCalled();
      await act(async () => root.render(<Terminal active sessionId="session-1" ws={socket} />));
      expect(mock.opened).toHaveBeenCalledTimes(1);
      expect(mock.refresh).toHaveBeenCalledWith(0, 29);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
