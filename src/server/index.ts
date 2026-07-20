import { pathToFileURL } from 'node:url';
import type { WebSocketServer } from 'ws';
import { loadConfig } from '../config.js';
import { CoordinationService } from '../coordination/service.js';
import { DiscoveryPoller } from '../discovery/poller.js';
import { ITerm2Adapter, TerminalAppAdapter, TerminalRegistry, VsCodeAdapter, VsCodeBridge } from '../discovery/terminals/index.js';
import { PtyBackend } from '../sessions/pty.js';
import { SessionManager } from '../sessions/manager.js';
import { openStore } from '../store/index.js';
import { buildApp } from './app.js';
import { attachWs, closeWs } from './ws.js';

export interface RunningServer { address: string; close: () => Promise<void> }

export async function startServer(): Promise<RunningServer> {
  const config = loadConfig();
  const port = process.env.AGENTDECK_DEV ? config.port + 1 : config.port;
  const store = openStore(config.dataDir);
  // Rows from a previous run are dead: managed sessions died with that
  // server process, and anything already marked exited has no process either.
  for (const session of store.listSessions()) {
    if (session.origin === 'managed' || session.status === 'exited') {
      store.deleteSession(session.id);
    }
  }
  const manager = new SessionManager(new PtyBackend(), store);
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
  const app = buildApp({ config, manager, store, terminals, coordination, vscode, discovery });
  let wss: WebSocketServer | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    discovery.stop(); coordination.stop();
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
    wss = attachWs(app.server, manager, '/ws', vscode);
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
