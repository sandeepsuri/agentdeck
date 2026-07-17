import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerFrame, ClientFrame } from '../../protocol.js';

interface Props {
  ws: WebSocket;
  sessionId: string;
}

/**
 * Live terminal for one managed session. Attaches over the shared WS,
 * replays the ring buffer, forwards keystrokes, and pushes resize frames
 * whenever the pane's size changes (fit addon + ResizeObserver).
 */
export function Terminal({ ws, sessionId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#111418' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const send = (frame: ClientFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    const sendResize = () => {
      fit.fit();
      send({ t: 'resize', cols: term.cols, rows: term.rows });
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

    const attach = () => {
      send({ t: 'attach', sessionId });
      sendResize();
    };
    if (ws.readyState === WebSocket.OPEN) attach();
    else ws.addEventListener('open', attach, { once: true });

    const dataDisposable = term.onData((data) => send({ t: 'input', data }));
    const observer = new ResizeObserver(sendResize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', attach);
      send({ t: 'detach' });
      term.dispose();
    };
  }, [ws, sessionId]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
