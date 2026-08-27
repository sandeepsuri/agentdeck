import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_COLS, TERMINAL_ROWS, type ServerFrame, type ClientFrame } from '../../protocol.js';
import { type ResolvedTheme, useTheme } from '../theme.js';

interface Props {
  ws: WebSocket;
  sessionId: string;
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
};

/**
 * Live terminal for one managed session. Attaches over the shared WS,
 * replays the ring buffer, and forwards keystrokes. The grid is pinned at
 * TERMINAL_COLS×TERMINAL_ROWS — matching the PTY's fixed size — and never
 * resized by the viewer; the host div centers it, so a pane larger than the
 * grid shows empty margin instead of stretching the terminal to fill it.
 */
export function Terminal({ ws, sessionId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
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

    const onMessage = (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      if (frame.t === 'replay') {
        term.reset();
        term.write(frame.data);
      } else if (frame.t === 'output') {
        term.write(frame.data);
      }
    };
    ws.addEventListener('message', onMessage);

    const attach = () => send({ t: 'attach', sessionId });
    if (ws.readyState === WebSocket.OPEN) attach();
    else ws.addEventListener('open', attach, { once: true });

    const dataDisposable = term.onData((data) => send({ t: 'input', data }));

    return () => {
      dataDisposable.dispose();
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', attach);
      send({ t: 'detach' });
      term.dispose();
      if (terminalRef.current === term) terminalRef.current = null;
    };
  }, [ws, sessionId]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = XTERM_THEMES[resolvedTheme];
  }, [resolvedTheme]);

  return (
    <div
      ref={hostRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
      }}
    />
  );
}
