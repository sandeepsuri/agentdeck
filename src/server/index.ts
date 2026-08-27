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
  const app = buildApp({ config, manager, store, terminals, coordination, vscode, discovery, modelCatalog });
  let wss: WebSocketServer | undefined;
  let companion: RunningCompanion | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    discovery.stop(); coordination.stop();
    companion?.close();
    await manager.shutdown();
    if (wss) await closeWs(wss);
    await app.close();
    store.close();
  };
  const onSignal = () => void close().then(() => process.exit(0));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const address = await app.listen({ port, host: '127.0.0.1' });
    wss = attachWs(app.server, manager, '/ws', vscode, () => {
      const sessions = manager.listSessions().map(publicSession);
      const events = store.listEvents({ limit: 1000 });
      const attention = deriveAttentionItems(sessions, events);
      return {
        sessions,
        attention,
        agents: deriveCompanionAgents(sessions, events, attention),
      };
    });
    companion = launchNativeCompanion(port);
    discovery.start();
    void coordination.syncRepos(store.listRepos());
    if (!store.getSetting<boolean>('firstRunShown')) {
      console.log('[agentdeck] First run: macOS may request Automation access when focusing terminal tabs. You can continue if denied and enable it later in System Settings → Privacy & Security → Automation.');
      store.setSetting('firstRunShown', true);
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
