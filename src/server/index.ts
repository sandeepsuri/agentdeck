import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebSocketServer } from 'ws';
import { loadConfig } from '../config.js';
import { CoordinationService } from '../coordination/service.js';
import { DiscoveryPoller } from '../discovery/poller.js';
import { ITerm2Adapter, TerminalAppAdapter, TerminalRegistry, VsCodeAdapter, VsCodeBridge } from '../discovery/terminals/index.js';
import { PtyBackend } from '../sessions/pty.js';
import { SessionManager } from '../sessions/manager.js';
import { ClaudeCliSummarizer, OpenAiSummarizer, RoutingSummarizer } from '../sessions/summarizer.js';
import { ClaudeModelSource, ModelCatalog, OpenAiModelSource } from '../sessions/model-catalog.js';
import { openStore } from '../store/index.js';
import { buildApp } from './app.js';
import { reconcileSessionsOnBoot } from './boot.js';
import { attachWs, closeWs } from './ws.js';
import { deriveAttentionItems, deriveCompanionAgents } from '../attention.js';
import { publicSession } from './security.js';
import { launchNativeCompanion, type RunningCompanion } from '../native/companion.js';
import { WakeLock } from './wake-lock.js';
import { configureRemoteAccess, listenOnTailnet } from './remote-access.js';
import { coordinateManagedWakeLock } from './managed-wake-lock.js';

export interface RunningServer { address: string; close: () => Promise<void> }

export async function startServer(): Promise<RunningServer> {
  const config = loadConfig();
  const port = process.env.AGENTDECK_DEV ? config.port + 1 : config.port;
  const store = openStore(config.dataDir);
  const sessionsDir = path.join(config.dataDir, 'sessions');
  // No managed PTY survives a restart, but an ended session's row does
  // (ticket 04) — mark still-live-looking managed rows exited rather than
  // deleting anything. Also compacts (ticket 09) any raw.log a hard kill
  // left behind with no scrollback.txt. See reconcileSessionsOnBoot for
  // the exact rules. Must finish before any managed session can relaunch
  // and start writing into the same sessionsDir.
  await reconcileSessionsOnBoot(store, sessionsDir);
  // Ticket 05: detect a Tailscale interface (undefined on any failure —
  // binary missing, not logged in, timeout — degrading to loopback-only,
  // never blocking startup). Prefer the MagicDNS hostname when available
  // since it's what a phone will most naturally be pointed at; the raw IP
  // is the fallback both for classify()'s host match and for the actual
  // second bind below (binding requires a concrete address either way).
  const remoteAccess = await configureRemoteAccess(config);
  // Second factor for remote access: generated once, ever, on first run
  // with no configured token, then persisted at 0600 (config.ts, same
  // pattern as openaiApiKey) and never regenerated afterward. It is never
  // returned by any REST/WS response — the one-time console.log below (and
  // reading ~/.agentdeck/config.json directly) are the only ways to see it.
  // Read live off `config` (not a snapshot) so a key saved later through
  // PATCH /api/settings (routes.ts mutates config.openaiApiKey in place)
  // is picked up by the very next summarize()/models call, with no
  // restart — same closure trick for both the catalog and the summarizer.
  const getOpenAiApiKey = () => config.openaiApiKey;
  const modelCatalog = new ModelCatalog([
    new ClaudeModelSource(),
    new OpenAiModelSource({ getApiKey: getOpenAiApiKey }),
  ]);
  const manager = new SessionManager(new PtyBackend(), store, {
    sessionsDir,
    // Ticket 12: one Summarizer, routing per-call by the model id's
    // provider prefix — see RoutingSummarizer's doc comment. This is what
    // lets the stored default or a per-run override choose between
    // providers without swapping what SessionManager was constructed with.
    summarizer: new RoutingSummarizer({
      adapters: {
        'claude-cli': new ClaudeCliSummarizer(),
        openai: new OpenAiSummarizer({ getApiKey: getOpenAiApiKey }),
      },
    }),
  });
  // Holds a `caffeinate` assertion while any managed session is live
  // (spec Stage 4 step 5). Wired directly on `manager`, independent of
  // ws.ts/attachWs, so this keeps working with zero WebSocket clients
  // connected. Same live-session predicate as
  // ui/workspace/model.tsx's isEndedSession, negated.
  const releaseWakeLock = coordinateManagedWakeLock(manager, new WakeLock());

  const vscode = new VsCodeBridge();
  const terminals = new TerminalRegistry([
    new TerminalAppAdapter(), new ITerm2Adapter(), new VsCodeAdapter(vscode),
  ]);
  const coordination = new CoordinationService(store, manager);
  const discovery = new DiscoveryPoller({
    store, intervalMs: config.pollIntervalMs,
    getManagedPids: () => manager.managedPids(),
    publish: (session) => {
      manager.publishSessionUpdate(session);
      coordination.reconcileSession(session);
    },
    remove: (sessionId) => manager.publishSessionRemoved(sessionId), terminals,
  });
  const app = buildApp({
    config, manager, store, terminals, coordination, vscode, discovery, modelCatalog,
    remoteHosts: remoteAccess.hosts,
  });
  let wss: WebSocketServer | undefined;
  let tailnetServer: HttpServer | undefined;
  let companion: RunningCompanion | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    discovery.stop(); coordination.stop();
    companion?.close();
    releaseWakeLock();
    await manager.shutdown();
    if (wss) await closeWs(wss);
    if (tailnetServer) await new Promise<void>((resolve) => tailnetServer!.close(() => resolve()));
    await app.close();
    store.close();
  };
  const onSignal = () => void close().then(() => process.exit(0));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    // Loopback bind stays exactly as before — never 0.0.0.0.
    const address = await app.listen({ port, host: '127.0.0.1' });
    const servers: HttpServer[] = [app.server];

    tailnetServer = await listenOnTailnet(app.server, port, remoteAccess.tailscale);
    if (tailnetServer) servers.push(tailnetServer);

    wss = attachWs(servers, manager, '/ws', vscode, () => {
      const sessions = manager.listSessions().map(publicSession);
      const events = store.listEvents({ limit: 1000 });
      const attention = deriveAttentionItems(sessions, events);
      return {
        sessions,
        attention,
        agents: deriveCompanionAgents(sessions, events, attention),
      };
    }, { remoteHosts: remoteAccess.hosts, token: config.tailscaleToken });

    companion = launchNativeCompanion(port);
    discovery.start();
    void coordination.syncRepos(store.listRepos());
    if (!store.getSetting<boolean>('firstRunShown')) {
      console.log('[agentdeck] First run: macOS may request Automation access when focusing terminal tabs. You can continue if denied and enable it later in System Settings → Privacy & Security → Automation.');
      store.setSetting('firstRunShown', true);
    }
    if (remoteAccess.generatedToken) {
      console.log(`[agentdeck] generated a tailnet access token: ${remoteAccess.generatedToken}`);
      const publicPort = process.env.AGENTDECK_DEV ? config.port : port;
      const preferredRemoteHost = remoteAccess.tailscale?.hostname ?? remoteAccess.tailscale?.ip;
      console.log(preferredRemoteHost
        ? `[agentdeck] Tailscale detected at ${preferredRemoteHost} — open http://${preferredRemoteHost}:${publicPort} on another device on the same tailnet and enter this token once.`
        : '[agentdeck] No Tailscale interface detected; remote access is unavailable until Tailscale is running on this machine.');
    }
    console.log(`[agentdeck] listening on ${address}`);
    return { address, close };
  } catch (error) {
    store.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error('[agentdeck] failed to start', error);
    process.exitCode = 1;
  });
}
