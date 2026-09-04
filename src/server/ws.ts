// WebSocket terminal bridge (T4): wires SessionManager events to attached
// sockets. Multiple viewers per session; a socket may keep multiple sessions
// attached, with every terminal frame scoped by session id.
//
// Ticket 05: the loopback bind and (when Tailscale is detected) a second
// bind on the tailnet interface both need this WS endpoint. `attachWs` now
// takes an array of underlying http.Servers and builds one `noServer: true`
// WebSocketServer, manually listening for 'upgrade' on each one so both
// share identical accept logic (see server/index.ts's dual bind).
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from '../sessions/manager.js';
import type { VsCodeBridge } from '../discovery/terminals/vscode.js';
import type { CompanionSnapshot } from '../types.js';
import { parseClientFrame, type ServerFrame } from '../protocol.js';
import { classify, toRunActor, TOKEN_QUERY_PARAM, type TrustResult } from './connection-trust.js';
import { publicSession } from './security.js';
import { isAllowedRemoteInput } from './remote-input.js';
import { LiveReflow, type Unsubscribe } from '../sessions/live-reflow.js';
import type { WorkEngine } from '../work-engine/types.js';
import type { CollaboratorService } from '../collaborators/service.js';

const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;

// Per-socket classification, set once at accept time (before the
// WebSocketServer's own 'connection' event fires) so ticket 14's raw-write
// enforcement — and anything else that needs to know what a connection may
// do — can look it up without re-deriving it from the (by-then-consumed)
// upgrade request.
const connectionTrust = new WeakMap<WebSocket, TrustResult>();

export function getConnectionTrust(ws: WebSocket): TrustResult | undefined {
  return connectionTrust.get(ws);
}

function rejectUpgrade(socket: NodeJS.WritableStream & { destroy: () => void }): void {
  const body = 'Unauthorized';
  try {
    (socket as unknown as { write: (chunk: string) => void }).write(
      `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } finally {
    socket.destroy();
  }
}

export function attachWs(
  servers: HttpServer[],
  manager: SessionManager,
  path = '/ws',
  vscode?: VsCodeBridge,
  companionSnapshot?: () => Omit<CompanionSnapshot, 'uiVisible'>,
  trust: { remoteHosts?: readonly string[]; token?: string } = {},
  /** Ticket 07: the same one policy path REST reaches (work-routes.ts) — see the 'run_attention_resolve' case below. Undefined only in tests that don't exercise Runs over WS. */
  workEngine?: WorkEngine,
  /** Ticket 11: resolves a collaborator device's bearer token for the upgrade's classify() call, and its onRevoke hook terminates any already-open socket for a device the instant it's revoked (AC5) — undefined only in tests that don't exercise collaborators. */
  collaborators?: CollaboratorService,
): WebSocketServer {
  // noServer: true because there are now potentially two underlying
  // http.Servers (loopback + tailnet); each one's 'upgrade' event is wired
  // below to the same WebSocketServer instance, running the same
  // ConnectionTrust check before ever calling handleUpgrade.
  const wss = new WebSocketServer({
    noServer: true,
    path,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  for (const server of servers) {
    server.on('upgrade', (req, socket, head) => {
      let pathname: string;
      let token: string | undefined;
      try {
        const url = new URL(req.url ?? '', 'http://placeholder');
        pathname = url.pathname;
        token = url.searchParams.get(TOKEN_QUERY_PARAM) ?? undefined;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== path) {
        socket.destroy();
        return;
      }
      // WebSocket upgrades bypass CORS: without this check any web page
      // could attach to a session, read its output, and inject keystrokes.
      // Same ConnectionTrust.classify() the REST onRequest hook and CSP use
      // (see app.ts) — a new allowed host can't be added there and missed
      // here. Browsers cannot set custom headers on a WS upgrade, so the
      // token travels as a query param (TOKEN_QUERY_PARAM) rather than a
      // header.
      const result = classify(
        { host: req.headers.host, origin: req.headers.origin, token },
        { ...trust, deviceLookup: collaborators?.resolveDevice },
      );
      const allowed = result.kind === 'local' || (result.kind === 'remote' && result.capabilities.size > 0);
      if (!allowed) {
        rejectUpgrade(socket);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        connectionTrust.set(ws, result);
        wss.emit('connection', ws, req);
      });
    });
  }

  // AC5: a device revoked while it holds an open socket is disconnected
  // immediately, not merely blocked on its next reconnect — every other
  // socket (this device's own REST calls have no equivalent long-lived
  // state to invalidate) is untouched.
  collaborators?.onRevoke((deviceId: string) => {
    for (const client of wss.clients) {
      if (getConnectionTrust(client)?.device?.id === deviceId) client.terminate();
    }
  });

  // socket → sessionIds it is viewing
  const viewing = new Map<WebSocket, Set<string>>();
  const uiPresence = new Map<WebSocket, boolean>();
  const managedSessionIds = new Set(
    manager.listSessions().filter((session) => session.origin === 'managed').map((session) => session.id),
  );

  // Ticket 13: one LiveReflow instance for the whole server, backed by the
  // manager's live transcripts. socket → sessionId → unsubscribe tracks
  // each remote viewer's subscription so 'detach' and the socket's 'close'
  // handler (below) can tear it down without leaking a shared timer.
  const liveReflow = new LiveReflow((sessionId) => manager.getTranscript(sessionId));
  const reflowSubs = new Map<WebSocket, Map<string, Unsubscribe>>();

  const send = (ws: WebSocket, frame: ServerFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  // A missing trust entry is treated as NOT local (fail-safe, withholding
  // raw PTY bytes) rather than defaulting to full desktop access — same
  // fail-safe direction ticket 14 uses for capability checks on the
  // 'input' path below. In practice every accepted connection has an entry
  // (set at upgrade time, see connectionTrust above) since it's populated
  // before the WebSocketServer's own 'connection' event fires, so this
  // only matters if that invariant is ever broken by a future change.
  // Denied connections never reach here at all (rejected at upgrade).
  const isLocalSocket = (ws: WebSocket): boolean => getConnectionTrust(ws)?.kind === 'local';
  // Ticket 11 AC4: a named collaborator's device is authenticated (so it
  // may hold an open socket — AC5 needs something for revocation to
  // terminate) but grants no raw *session* terminal capability over WS —
  // 'attach' below stays refused for it, the same boundary app.ts's
  // onRequest hook draws for REST (isCollaboratorViewRoute never includes
  // a session route). Run *guidance* ('run_attention_resolve') is
  // different: ticket 12 lets a collaborator device reach it too, gated by
  // its own RunActor grants inside DurableWorkEngine.resolveAttention()
  // (see that case below) rather than an unscoped socket-level allow here.
  const isCollaboratorSocket = (ws: WebSocket): boolean => getConnectionTrust(ws)?.device !== undefined;
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
    for (const ws of wss.clients) {
      if (isLocalSocket(ws)) send(ws, { t: 'companion_snapshot', snapshot });
    }
  };

  manager.on('output', (sessionId, data) => {
    // Raw PTY bytes are a desktop-grid concept: a remote (phone) socket
    // must never receive them, regardless of what it's attached to — it
    // only ever gets 'reflow_text' (see the 'attach' case below and
    // LiveReflow). Ticket 05's ConnectionTrust decided this once; this is
    // one of the four places that ask it (see connection-trust.ts).
    for (const [ws, sessionIds] of viewing) {
      if (sessionIds.has(sessionId) && isLocalSocket(ws)) send(ws, { t: 'output', sessionId, data });
    }
    // Mission Control tiles are not "attached" viewers — push a lightweight
    // preview chunk to every socket so grid tiles update live without each
    // tile polling its own REST endpoint. Local-only for the same reason:
    // Mission Control is a desktop-grid concept a phone has no use for, and
    // this carries raw bytes too.
    for (const ws of wss.clients) {
      if (isLocalSocket(ws)) send(ws, { t: 'tile_preview', sessionId, data, seed: false });
    }
  });

  // Local sockets see the global list; remote sockets see managed sessions only.
  //
  // Ticket 15: a collaborator device is excluded from both session broadcasts
  // below, the same boundary 'attach' already draws for it (see
  // isCollaboratorSocket's comment above and the 'attach' case). Without this
  // it received a live 'session_update' for every managed Session on the
  // machine -- publicSession only strips launchSpec, so cwd, worktreePath,
  // repoId, and title crossed out for Repositories that device was never
  // granted, while app.ts refuses it GET /api/sessions outright. The two
  // boundaries have to agree, and REST's is the correct one.
  manager.on('session_update', (session) => {
    if (session.origin === 'managed') managedSessionIds.add(session.id);
    for (const ws of wss.clients) {
      if (isLocalSocket(ws) || (session.origin === 'managed' && !isCollaboratorSocket(ws))) {
        send(ws, { t: 'session_update', session: publicSession(session) });
      }
    }
    broadcastCompanionSnapshot();
  });

  manager.on('session_removed', (sessionId) => {
    for (const [ws, sessionIds] of viewing) {
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) viewing.delete(ws);
    }
    const wasManaged = managedSessionIds.delete(sessionId);
    for (const ws of wss.clients) {
      if (isLocalSocket(ws) || (wasManaged && !isCollaboratorSocket(ws))) send(ws, { t: 'session_removed', sessionId });
    }
    broadcastCompanionSnapshot();
  });

  manager.on('agent_event', (event) => {
    for (const ws of wss.clients) {
      if (isLocalSocket(ws)) send(ws, { t: 'agent_event', event });
    }
    broadcastCompanionSnapshot();
  });

  wss.on('connection', (ws) => {
    if (companionSnapshot && isLocalSocket(ws)) {
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
    // output batch arrives. Local-only: this carries raw PTY bytes, and
    // Mission Control tiles are a desktop-grid concept a phone has no use
    // for (see the 'output' handler above for the same restriction).
    if (isLocalSocket(ws)) {
      for (const session of manager.listSessions()) {
        if (session.origin === 'managed' && manager.isLive(session.id)) {
          send(ws, { t: 'tile_preview', sessionId: session.id, data: manager.getBuffer(session.id), seed: true });
        }
      }
    }
    ws.on('message', (raw) => {
      const frame = parseClientFrame(String(raw));
      if (!frame) return;
      switch (frame.t) {
        case 'attach': {
          if (isCollaboratorSocket(ws)) return;
          const session = manager.getSession(frame.sessionId);
          if (!session || (!isLocalSocket(ws) && session.origin !== 'managed')) return;
          const sessionIds = viewing.get(ws) ?? new Set<string>();
          sessionIds.add(frame.sessionId);
          viewing.set(ws, sessionIds);
          if (isLocalSocket(ws)) {
            // Desktop path, byte-for-byte unchanged from before ticket 13.
            send(ws, { t: 'replay', sessionId: frame.sessionId, data: manager.getBuffer(frame.sessionId) });
          } else {
            // Remote (phone) viewer: no raw replay/output ever. LiveReflow
            // owns the shared per-session timer; guard against a duplicate
            // attach (no intervening detach) leaking a second subscription.
            const subs = reflowSubs.get(ws) ?? new Map<string, Unsubscribe>();
            if (!subs.has(frame.sessionId)) {
              const sessionId = frame.sessionId;
              const unsubscribe = liveReflow.attach(sessionId, (text) => {
                send(ws, { t: 'reflow_text', sessionId, text });
              });
              subs.set(sessionId, unsubscribe);
              reflowSubs.set(ws, subs);
            }
          }
          break;
        }
        case 'detach': {
          const sessionIds = viewing.get(ws);
          sessionIds?.delete(frame.sessionId);
          if (sessionIds?.size === 0) viewing.delete(ws);
          const subs = reflowSubs.get(ws);
          const unsubscribe = subs?.get(frame.sessionId);
          if (subs && unsubscribe) {
            unsubscribe();
            subs.delete(frame.sessionId);
            if (subs.size === 0) reflowSubs.delete(ws);
          }
          break;
        }
        case 'input': {
          const sessionIds = viewing.get(ws);
          if (sessionIds?.has(frame.sessionId) && manager.isLive(frame.sessionId)) {
            // Ticket 14: a connection without 'raw-write' (remote, or —
            // fail safe — one whose trust result is missing entirely) may
            // only pass through the fixed control-key set. Refusal is a
            // silent no-op, the same shape as the existing viewing/isLive
            // checks above, not an error frame back to the client.
            const hasRawWrite = getConnectionTrust(ws)?.capabilities.has('raw-write') ?? false;
            if (hasRawWrite || isAllowedRemoteInput(frame.data)) {
              manager.write(frame.sessionId, frame.data);
            }
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
        case 'run_attention_resolve': {
          // Ticket 07 AC2: the same DurableWorkEngine.resolveAttention()
          // REST reaches (work-routes.ts) — fire-and-forget, same shape as
          // 'input' above; a rejection (already resolved, wrong kind, no
          // such Run) surfaces on the next Run read rather than an error
          // frame back to the client, since there's no dedicated Run push
          // channel yet (local/mobile UI polls GET /api/runs* instead).
          // 'compose' is granted to every local socket and every
          // authenticated remote one (connection-trust.ts) — a missing
          // trust entry (should never happen post-upgrade) fails safe by
          // withholding it, same direction as the 'input' case's raw-write
          // check above.
          if (!workEngine) break;
          const hasCompose = getConnectionTrust(ws)?.capabilities.has('compose') ?? false;
          if (!hasCompose) break;
          const decision = frame.decision === 'input' ? { kind: 'input' as const, value: frame.value } : { kind: frame.decision };
          // Ticket 12 AC1/AC7: a resolved collaborator device's RunActor
          // (with grants) reaches the exact same
          // DurableWorkEngine.resolveAttention() policy enforcement REST
          // does (work-routes.ts) — a Run outside its grants is refused
          // there, not here; this socket never decides that itself.
          // Undefined for local and the legacy shared-token path, exactly
          // like every other actor-accepting call site.
          const device = getConnectionTrust(ws)?.device;
          const args: Parameters<typeof workEngine.resolveAttention> = device
            ? [frame.runId, frame.attentionId, decision, toRunActor(device)]
            : [frame.runId, frame.attentionId, decision];
          workEngine.resolveAttention(...args).catch(() => undefined);
          break;
        }
      }
    });
    ws.on('close', () => {
      viewing.delete(ws);
      const subs = reflowSubs.get(ws);
      if (subs) {
        for (const unsubscribe of subs.values()) unsubscribe();
        reflowSubs.delete(ws);
      }
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
