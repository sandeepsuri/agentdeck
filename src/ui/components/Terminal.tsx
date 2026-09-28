import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_COLS, TERMINAL_ROWS, type ServerFrame, type ClientFrame } from '../../protocol.js';
import { type ResolvedTheme, useTheme } from '../theme.js';
import { BASE_FONT_SIZE, createWheelAccumulator, fitFontSize, isAtBottom } from './terminalScroll.js';

interface Props {
  ws: WebSocket;
  sessionId: string;
  active: boolean;
}

const XTERM_THEMES: Record<ResolvedTheme, ITheme> = {
  light: {
    background: '#fbfaf6',
    foreground: '#171714',
    cursor: '#45443e',
    cursorAccent: '#fbfaf6',
    selectionBackground: '#ddd8cb',
    black: '#171714',
    red: '#b4232d',
    green: '#18794e',
    yellow: '#9a6500',
    blue: '#2563a8',
    magenta: '#76518a',
    cyan: '#1e7180',
    white: '#f5f2ea',
    brightBlack: '#686b66',
    brightRed: '#c63b43',
    brightGreen: '#238c5d',
    brightYellow: '#ad760c',
    brightBlue: '#3474ba',
    brightMagenta: '#895f9f',
    brightCyan: '#2b8392',
    brightWhite: '#ffffff',
  },
  dark: {
    background: '#090909',
    foreground: '#f2f0e8',
    cursor: '#d9d6cc',
    cursorAccent: '#090909',
    selectionBackground: '#35352f',
    black: '#090909',
    red: '#f07178',
    green: '#55d98b',
    yellow: '#f5b94c',
    blue: '#6ca8ff',
    magenta: '#c6a0d8',
    cyan: '#71c7d3',
    white: '#f2f0e8',
    brightBlack: '#7c817c',
    brightRed: '#ff8b91',
    brightGreen: '#75e39d',
    brightYellow: '#ffd072',
    brightBlue: '#8bbcff',
    brightMagenta: '#d8b6e6',
    brightCyan: '#8bd8e1',
    brightWhite: '#ffffff',
  },
  midnight: {
    background: '#070d18',
    foreground: '#e8f0fa',
    cursor: '#8bb7ed',
    cursorAccent: '#070d18',
    selectionBackground: '#1d3150',
    black: '#070d18',
    red: '#f0838d',
    green: '#6ed6a0',
    yellow: '#e7bd70',
    blue: '#83b9ff',
    magenta: '#b9a2e8',
    cyan: '#73c9dd',
    white: '#d7e1ef',
    brightBlack: '#7889a1',
    brightRed: '#f6a0a8',
    brightGreen: '#8be2b4',
    brightYellow: '#f1cf91',
    brightBlue: '#a7cdff',
    brightMagenta: '#cebaf2',
    brightCyan: '#94d9e8',
    brightWhite: '#ffffff',
  },
  slate: {
    background: '#121519',
    foreground: '#eef1f3',
    cursor: '#c0cad4',
    cursorAccent: '#121519',
    selectionBackground: '#303a44',
    black: '#121519',
    red: '#e6858b',
    green: '#78c99a',
    yellow: '#d9b66c',
    blue: '#81b4e6',
    magenta: '#ab9bd1',
    cyan: '#75becb',
    white: '#d8dde1',
    brightBlack: '#858f99',
    brightRed: '#ee9aa0',
    brightGreen: '#91d7ae',
    brightYellow: '#e5c788',
    brightBlue: '#9fc8ee',
    brightMagenta: '#c0b1df',
    brightCyan: '#91d0da',
    brightWhite: '#ffffff',
  },
  nord: {
    background: '#242933',
    foreground: '#eceff4',
    cursor: '#d8dee9',
    cursorAccent: '#242933',
    selectionBackground: '#414b5d',
    black: '#242933',
    red: '#db8189',
    green: '#9ac597',
    yellow: '#ebcb8b',
    blue: '#8fbcdf',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#d8dee9',
    brightBlack: '#909caf',
    brightRed: '#e6949b',
    brightGreen: '#afd5ab',
    brightYellow: '#f2d9a6',
    brightBlue: '#a7cae5',
    brightMagenta: '#c7a5c1',
    brightCyan: '#a2d1dd',
    brightWhite: '#ffffff',
  },
  solar: {
    background: '#18150f',
    foreground: '#f0e7d2',
    cursor: '#e4bd70',
    cursorAccent: '#18150f',
    selectionBackground: '#3d3424',
    black: '#18150f',
    red: '#e3847d',
    green: '#8fc28f',
    yellow: '#e4bd70',
    blue: '#7fb4cf',
    magenta: '#b09ac8',
    cyan: '#78bdba',
    white: '#ddd2ba',
    brightBlack: '#918570',
    brightRed: '#ec9992',
    brightGreen: '#a7d0a5',
    brightYellow: '#f0cf8d',
    brightBlue: '#9ac6dc',
    brightMagenta: '#c5afd8',
    brightCyan: '#94cecb',
    brightWhite: '#fffaf0',
  },
  forest: {
    background: '#09130f',
    foreground: '#e6efe9',
    cursor: '#aad0b6',
    cursorAccent: '#09130f',
    selectionBackground: '#254032',
    black: '#09130f',
    red: '#e18486',
    green: '#83c79b',
    yellow: '#d8b66d',
    blue: '#7eacd2',
    magenta: '#a895c8',
    cyan: '#78bab5',
    white: '#d6e3da',
    brightBlack: '#7f9587',
    brightRed: '#eb999a',
    brightGreen: '#9bd5ae',
    brightYellow: '#e4c88c',
    brightBlue: '#98bfdf',
    brightMagenta: '#beadd8',
    brightCyan: '#93cbc7',
    brightWhite: '#f8fff9',
  },
  signature: {
    background: '#100c18',
    foreground: '#f0ebf7',
    cursor: '#c7b1f3',
    cursorAccent: '#100c18',
    selectionBackground: '#34284a',
    black: '#100c18',
    red: '#eb828f',
    green: '#78c99b',
    yellow: '#dfb96f',
    blue: '#8eaff2',
    magenta: '#c0a4ed',
    cyan: '#78bdcf',
    white: '#dfd7e9',
    brightBlack: '#8d7f9f',
    brightRed: '#f09aa5',
    brightGreen: '#91d7ae',
    brightYellow: '#ebca8c',
    brightBlue: '#a9c2f7',
    brightMagenta: '#d1b9f5',
    brightCyan: '#94cfdd',
    brightWhite: '#ffffff',
  },
};

/**
 * Live terminal for one managed session. Attaches over the shared WS,
 * replays the ring buffer, and forwards keystrokes. The grid is pinned at
 * TERMINAL_COLS×TERMINAL_ROWS — matching the PTY's fixed size — and never
 * resized by the viewer; in a smaller pane the font shrinks so the whole
 * grid stays visible and xterm's viewport is the only scroller.
 */
export function Terminal({ ws, sessionId, active }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: BASE_FONT_SIZE,
      theme: XTERM_THEMES[resolvedTheme],
      scrollback: 5000,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    });
    terminalRef.current = term;
    term.open(host);

    const send = (frame: ClientFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const syncAtBottom = () => setAtBottom(isAtBottom(term.buffer.active));

    const onMessage = (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      if (frame.t === 'replay' && frame.sessionId === sessionId) {
        term.reset();
        term.write(frame.data, syncAtBottom);
      } else if (frame.t === 'output' && frame.sessionId === sessionId) {
        term.write(frame.data, syncAtBottom);
      }
    };
    ws.addEventListener('message', onMessage);

    const attach = () => send({ t: 'attach', sessionId });
    if (ws.readyState === WebSocket.OPEN) attach();
    else ws.addEventListener('open', attach, { once: true });

    const dataDisposable = term.onData((data) => send({ t: 'input', sessionId, data }));
    const scrollDisposable = term.onScroll(syncAtBottom);

    // In the normal buffer the wheel scrolls history, never the TUI. In the
    // alternate screen there is no history, so the app gets the wheel.
    const wheelLines = createWheelAccumulator();
    term.attachCustomWheelEventHandler((event) => {
      if (term.buffer.active.type === 'alternate') return true;
      event.preventDefault();
      const rowHeight = host.clientHeight > 0 ? host.clientHeight / TERMINAL_ROWS : BASE_FONT_SIZE * 1.2;
      const lines = wheelLines(event, rowHeight, TERMINAL_ROWS);
      if (lines !== 0) term.scrollLines(lines);
      return false;
    });

    // Measure the grid once at the base font, then fit it to the pane.
    const frame = frameRef.current;
    let gridAtBase: { width: number; height: number } | null = null;
    const fit = () => {
      if (!frame || frame.clientWidth === 0 || frame.clientHeight === 0) return;
      if (!gridAtBase) {
        const screen = host.querySelector('.xterm-screen');
        if (!screen || screen.clientWidth === 0) return;
        gridAtBase = { width: screen.clientWidth, height: screen.clientHeight };
      }
      const fontSize = fitFontSize({ width: frame.clientWidth, height: frame.clientHeight }, gridAtBase);
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    if (frame) observer?.observe(frame);
    fit();

    return () => {
      observer?.disconnect();
      dataDisposable.dispose();
      scrollDisposable.dispose();
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', attach);
      send({ t: 'detach', sessionId });
      term.dispose();
      if (terminalRef.current === term) terminalRef.current = null;
    };
  }, [ws, sessionId]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = XTERM_THEMES[resolvedTheme];
  }, [resolvedTheme]);

  useEffect(() => {
    if (!active) return;
    // Kept-mounted terminals receive output while hidden. Repaint after the
    // CSS display toggle so xterm measures and draws the visible canvas again.
    const frame = requestAnimationFrame(() => terminalRef.current?.refresh(0, TERMINAL_ROWS - 1));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="managed-terminal" ref={frameRef}>
      <div className="managed-terminal-host" ref={hostRef} />
      {!atBottom && (
        <button
          className="terminal-jump-latest"
          onClick={() => { terminalRef.current?.scrollToBottom(); setAtBottom(true); terminalRef.current?.focus(); }}
          type="button"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
