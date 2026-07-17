// WebSocket terminal bridge (T4): wires SessionManager events to attached
// sockets. Multiple viewers per session; a socket views one session at a time.
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from '../sessions/manager.js';
import { parseClientFrame, type ServerFrame } from '../protocol.js';
import { isAllowedOrigin, isLoopbackHostHeader } from './app.js';

export function attachWs(server: HttpServer, manager: SessionManager, path = '/ws'): WebSocketServer {
  // WebSocket upgrades bypass CORS: without this check any web page could
  // attach to a session, read its output, and inject keystrokes.
  const wss = new WebSocketServer({
    server,
    path,
    verifyClient: ({ origin, req }: { origin?: string; req: { headers: { host?: string } } }) =>
      isLoopbackHostHeader(req.headers.host) && isAllowedOrigin(origin),
  });

  // socket → sessionId it's viewing
  const viewing = new Map<WebSocket, string>();

  const send = (ws: WebSocket, frame: ServerFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  manager.on('output', (sessionId, data) => {
    for (const [ws, sid] of viewing) {
      if (sid === sessionId) send(ws, { t: 'output', data });
    }
  });

  // session_update goes to every socket — the session list is global state.
  manager.on('session_update', (session) => {
    for (const ws of wss.clients) send(ws, { t: 'session_update', session });
  });

  manager.on('agent_event', (event) => {
    for (const ws of wss.clients) send(ws, { t: 'agent_event', event });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = parseClientFrame(String(raw));
      if (!frame) return;
      switch (frame.t) {
        case 'attach': {
          if (!manager.getSession(frame.sessionId)) return;
          viewing.set(ws, frame.sessionId);
          send(ws, { t: 'replay', data: manager.getBuffer(frame.sessionId) });
          break;
        }
        case 'detach':
          viewing.delete(ws);
          break;
        case 'input': {
          const sid = viewing.get(ws);
          if (sid !== undefined && manager.isLive(sid)) manager.write(sid, frame.data);
          break;
        }
        case 'resize': {
          const sid = viewing.get(ws);
          if (sid !== undefined && manager.isLive(sid)) {
            manager.resize(sid, frame.cols, frame.rows);
          }
          break;
        }
      }
    });
    ws.on('close', () => viewing.delete(ws));
  });

  return wss;
}

export async function closeWs(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => {
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
