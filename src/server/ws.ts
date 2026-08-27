// WebSocket terminal bridge (T4): wires SessionManager events to attached
// sockets. Multiple viewers per session; a socket may keep multiple sessions
// attached, with every terminal frame scoped by session id.
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from '../sessions/manager.js';
import type { VsCodeBridge } from '../discovery/terminals/vscode.js';
import type { CompanionSnapshot } from '../types.js';
import { parseClientFrame, type ServerFrame } from '../protocol.js';
import { isAllowedOrigin, isLoopbackHostHeader } from './app.js';
import { publicSession } from './security.js';

const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;

export function attachWs(
  server: HttpServer,
  manager: SessionManager,
  path = '/ws',
  vscode?: VsCodeBridge,
  companionSnapshot?: () => Omit<CompanionSnapshot, 'uiVisible'>,
): WebSocketServer {
  // WebSocket upgrades bypass CORS: without this check any web page could
  // attach to a session, read its output, and inject keystrokes.
  const wss = new WebSocketServer({
    server,
    path,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ origin, req }: { origin?: string; req: { headers: { host?: string } } }) =>
      isLoopbackHostHeader(req.headers.host) && isAllowedOrigin(origin, req.headers.host),
  });

  // socket → sessionIds it is viewing
  const viewing = new Map<WebSocket, Set<string>>();
  const uiPresence = new Map<WebSocket, boolean>();

  const send = (ws: WebSocket, frame: ServerFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const isUiVisible = () => [...uiPresence.values()].some(Boolean);
  const broadcastPresence = () => {
    const visible = isUiVisible();
    for (const ws of wss.clients) send(ws, { t: 'ui_presence', visible });
  };
  const broadcastCompanionSnapshot = () => {
    if (!companionSnapshot) return;
    const provided = companionSnapshot();
    const snapshot = {
      ...provided,
      sessions: provided.sessions.map(publicSession),
      uiVisible: isUiVisible(),
    };
    for (const ws of wss.clients) send(ws, { t: 'companion_snapshot', snapshot });
  };

  manager.on('output', (sessionId, data) => {
    for (const [ws, sessionIds] of viewing) {
      if (sessionIds.has(sessionId)) send(ws, { t: 'output', sessionId, data });
    }
    // Mission Control tiles are not "attached" viewers — push a lightweight
    // preview chunk to every socket so grid tiles update live without each
    // tile polling its own REST endpoint.
    for (const ws of wss.clients) send(ws, { t: 'tile_preview', sessionId, data, seed: false });
  });

  // session_update goes to every socket — the session list is global state.
  manager.on('session_update', (session) => {
    for (const ws of wss.clients) send(ws, { t: 'session_update', session: publicSession(session) });
    broadcastCompanionSnapshot();
  });

  manager.on('session_removed', (sessionId) => {
    for (const [ws, sessionIds] of viewing) {
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) viewing.delete(ws);
    }
    for (const ws of wss.clients) send(ws, { t: 'session_removed', sessionId });
    broadcastCompanionSnapshot();
  });

  manager.on('agent_event', (event) => {
    for (const ws of wss.clients) send(ws, { t: 'agent_event', event });
    broadcastCompanionSnapshot();
  });

  wss.on('connection', (ws) => {
    if (companionSnapshot) {
      const provided = companionSnapshot();
      send(ws, { t: 'ui_presence', visible: isUiVisible() });
      send(ws, {
        t: 'companion_snapshot',
        snapshot: {
          ...provided,
          sessions: provided.sessions.map(publicSession),
          uiVisible: isUiVisible(),
        },
      });
    }
    // Seed Mission Control tiles with whatever a managed session has already
    // produced, so a freshly opened grid doesn't sit blank until the next
    // output batch arrives.
    for (const session of manager.listSessions()) {
      if (session.origin === 'managed' && manager.isLive(session.id)) {
        send(ws, { t: 'tile_preview', sessionId: session.id, data: manager.getBuffer(session.id), seed: true });
      }
    }
    ws.on('message', (raw) => {
      const frame = parseClientFrame(String(raw));
      if (!frame) return;
      switch (frame.t) {
        case 'attach': {
          if (!manager.getSession(frame.sessionId)) return;
          const sessionIds = viewing.get(ws) ?? new Set<string>();
          sessionIds.add(frame.sessionId);
          viewing.set(ws, sessionIds);
          send(ws, { t: 'replay', sessionId: frame.sessionId, data: manager.getBuffer(frame.sessionId) });
          break;
        }
        case 'detach': {
          const sessionIds = viewing.get(ws);
          sessionIds?.delete(frame.sessionId);
          if (sessionIds?.size === 0) viewing.delete(ws);
          break;
        }
        case 'input': {
          const sessionIds = viewing.get(ws);
          if (sessionIds?.has(frame.sessionId) && manager.isLive(frame.sessionId)) {
            manager.write(frame.sessionId, frame.data);
          }
          break;
        }
        case 'vscode_register':
          vscode?.register(ws, frame.windowId, frame.terminals);
          break;
        case 'vscode_terminals':
          vscode?.update(ws, frame.windowId, frame.terminals);
          break;
        case 'vscode_result':
          vscode?.result(ws, frame.requestId, frame.ok, frame.error);
          break;
        case 'ui_presence':
          uiPresence.set(ws, frame.visible);
          broadcastPresence();
          broadcastCompanionSnapshot();
          break;
      }
    });
    ws.on('close', () => {
      viewing.delete(ws);
      if (uiPresence.delete(ws)) {
        broadcastPresence();
        broadcastCompanionSnapshot();
      }
      vscode?.disconnect(ws);
    });
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
