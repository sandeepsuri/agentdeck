// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal.js';

const mock = vi.hoisted(() => ({
  refresh: vi.fn(), opened: vi.fn(), disposed: vi.fn(), scrollLines: vi.fn(), scrollToBottom: vi.fn(),
  wheel: undefined as ((event: WheelEvent) => boolean) | undefined,
  scrolled: undefined as (() => void) | undefined,
  buffer: { type: 'normal', viewportY: 0, baseY: 0 },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { theme: {} };
    open = mock.opened;
    refresh = mock.refresh;
    dispose = mock.disposed;
    scrollLines = mock.scrollLines;
    scrollToBottom = mock.scrollToBottom;
    focus = vi.fn();
    buffer = { get active() { return mock.buffer; } };
    onData = () => ({ dispose: vi.fn() });
    onScroll = (callback: () => void) => { mock.scrolled = callback; return { dispose: vi.fn() }; };
    attachCustomWheelEventHandler = (handler: (event: WheelEvent) => boolean) => { mock.wheel = handler; };
    reset = vi.fn();
    write = vi.fn();
  },
}));
vi.mock('../theme.js', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => {
  vi.unstubAllGlobals();
  for (const fn of [mock.refresh, mock.opened, mock.disposed, mock.scrollLines, mock.scrollToBottom]) fn.mockClear();
  mock.buffer = { type: 'normal', viewportY: 0, baseY: 0 };
});

async function renderTerminal() {
  const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN, send: vi.fn() }) as unknown as WebSocket;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Terminal active sessionId="session-1" ws={socket} />));
  return { host, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

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

describe('managed terminal scrolling', () => {
  it('scrolls xterm history on the wheel instead of sending it to a TUI that captured the mouse', async () => {
    const { cleanup } = await renderTerminal();
    try {
      const event = new WheelEvent('wheel', { deltaY: -3, deltaMode: 1, cancelable: true });
      expect(mock.wheel!(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(mock.scrollLines).toHaveBeenCalledWith(-3);
    } finally {
      await cleanup();
    }
  });

  it('leaves the wheel to the app in the alternate screen, which has no history', async () => {
    const { cleanup } = await renderTerminal();
    try {
      mock.buffer = { type: 'alternate', viewportY: 0, baseY: 0 };
      expect(mock.wheel!(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }))).toBe(true);
      expect(mock.scrollLines).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('offers Jump to latest once scrolled up, and returns to the newest output', async () => {
    const { host, cleanup } = await renderTerminal();
    try {
      expect(host.querySelector('.terminal-jump-latest')).toBeNull();
      mock.buffer = { type: 'normal', viewportY: 10, baseY: 40 };
      await act(async () => mock.scrolled!());
      const jump = host.querySelector<HTMLButtonElement>('.terminal-jump-latest')!;
      expect(jump.textContent).toContain('Jump to latest');
      await act(async () => jump.click());
      expect(mock.scrollToBottom).toHaveBeenCalled();
      expect(host.querySelector('.terminal-jump-latest')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
