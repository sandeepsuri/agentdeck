import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyRequest } from 'fastify';
import type { WebSocketServer } from 'ws';
import { loadConfig, saveConfig } from '../config.js';
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
import { deriveAttentionItems, deriveCompanionAgents, deriveRunAttentionItems } from '../attention.js';
import { publicSession } from './security.js';
import { launchNativeCompanion, type RunningCompanion } from '../native/companion.js';
import { nativeCaptureDriver } from '../native/window-capture.js';
import { WindowViewService } from '../window-view/service.js';
import { WakeLock } from './wake-lock.js';
import { configureRemoteAccess, listenOnTailnet } from './remote-access.js';
import { coordinateManagedWakeLock } from './managed-wake-lock.js';
import { DurableWorkEngine } from '../work-engine/engine.js';
import { registerWorkRoutes } from './work-routes.js';
import { CollaboratorService } from '../collaborators/service.js';
import { OwnerPairingService } from '../owner-pairing/service.js';
import { resolveLocalPrincipal } from '../work-engine/principal.js';
import { classify, toRunActor, TOKEN_HEADER } from './connection-trust.js';
import { resolveSenderIdentity } from './session-conversation.js';
import { RunPreviewServer } from './run-preview-server.js';
import { UsageQueries } from '../usage/aggregate.js';
import { UsageIndexer } from '../usage/indexer.js';
import { ModelNewsService } from '../usage/news.js';
import { DEFAULT_PRICING } from '../usage/pricing.js';
import { PersonalTaskService } from '../personal-tasks/service.js';
import { macFolderPicker } from '../personal-tasks/folder-picker.js';
import { folderAccess } from '../folder-access.js';
import { AgentAccess, claudeConfinementProver } from '../personal-tasks/agent-access.js';
import { confinedClaudeProvider } from '../personal-tasks/confined-provider.js';
import { EmailTaskService, gmailAccess } from '../personal-tasks/email/service.js';
import { RoutineService } from '../personal-tasks/routines/service.js';
import { keychainTokenVault } from '../personal-tasks/email/keychain.js';
import { RELAY_KEYCHAIN_SERVICE } from '../relay/identity.js';
import { RelayService } from '../relay/service.js';
import { relayDispatcher } from './relay-dispatch.js';
import { ProviderSetupService } from '../provider-setup/service.js';
import { macProviderCommands } from '../provider-setup/commands.js';

/** Tells the Mac app to relaunch the service rather than report a crash. */
const SERVICE_RESTART_EXIT_CODE = 75;

export interface RunningServer { address: string; close: () => Promise<void> }

export async function startServer(): Promise<RunningServer> {
  const config = loadConfig();
  const port = process.env.AGENTDECK_DEV ? config.port + 1 : config.port;
  const store = openStore(config.dataDir);
  // Ticket 70 (B10): loopback-only, ephemeral, never persisted — dies with
  // this process (see close() in the shutdown path below).
  const runPreviewServer = new RunPreviewServer();
  const workEngine = new DurableWorkEngine(store, path.join(config.dataDir, 'runs'));
  // Wired as a plain field assignment, not a constructor argument — see
  // DurableWorkEngine.onWorktreeReset's own doc comment for why.
  workEngine.onWorktreeReset = (runId) => runPreviewServer.invalidate(runId);
  // Ticket 11: named collaborators and their device credentials, backed by
  // the same durable store as everything else — survives a restart exactly
  // like a queued Run does.
  const collaborators = new CollaboratorService(store);
  const ownerPairing = new OwnerPairingService(store.ownerDevices);
  // Ticket 06: no in-memory Attempt task survives a restart, so any Run
  // still 'running' from before this process started is ended now with a
  // precise unrecoverable reason rather than left stuck — see
  // DurableWorkEngine.recover. Must finish before any route can observe or
  // start a Run.
  await workEngine.recover();
  // Issue #80: personal tasks are separate from Runs. An attempt interrupted
  // by the last shutdown is ended without a result and run again under the
  // same task id; a revoked grant fails it instead of reading. Filing
  // proposals (issue #81) use the confined Claude Code provider only when
  // this Mac's recorded confinement evidence passes the gate.
  // AgentAccess records that evidence itself: it runs the live probe while
  // the gate is off, so no owner has to run scripts/probe-confinement.ts.
  const agentAccess = new AgentAccess({
    provider: confinedClaudeProvider({ dataDir: config.dataDir }),
    prover: claudeConfinementProver({ dataDir: config.dataDir }),
  });
  const confinedProvider = agentAccess.provider;
  // Issue #90: the Mac dials out to the owner's relay so paired phones reach
  // it away from home; nothing listens for the relay. Revoking a phone ends
  // its relay connections at once, and a task that comes to need the owner
  // sends phones a push that says only that.
  const relay = new RelayService({
    vault: keychainTokenVault(undefined, RELAY_KEYCHAIN_SERVICE),
    ...(config.relayUrl ? { url: config.relayUrl } : {}),
    save: (url) => { saveConfig({ relayUrl: url }); config.relayUrl = url; },
    lookupPhone: (publicKey) => ownerPairing.byPublicKey(publicKey),
    log: (message) => console.log(message),
  });
  ownerPairing.onRevoke((deviceId) => relay.dropDevice(deviceId));
  const personalTasks = new PersonalTaskService({
    repository: store.personal,
    protectedRoots: [config.dataDir],
    filingProvider: confinedProvider,
    onNeedsOwner: () => relay.push(ownerPairing.pushTargets()),
  });
  personalTasks.recover();
  // Issue #88: find an email and prepare a reply through the same confined
  // provider. Gmail sign-ins live in the login Keychain; a draft write left
  // unsettled by the last shutdown is settled from Gmail, never written twice.
  const providerCommands = macProviderCommands();
  const emailTasks = new EmailTaskService({
    repository: store.email,
    gmail: gmailAccess({ dataDir: config.dataDir, openUrl: (url) => void providerCommands.openUrl(url).catch(() => undefined) }),
    vault: keychainTokenVault(),
    provider: confinedProvider,
  });
  emailTasks.recover();
  // Issue #92: saved routines start new personal and email tasks through the
  // services above, so each run keeps their checks and approvals.
  const routines = new RoutineService({ repository: store.routines, personal: personalTasks, email: emailTasks });
  // Issue #85: provider CLI setup from the Mac app. Only the last readiness
  // check is persisted; it shows as unconfirmed until re-checked this launch.
  const providerSetup = new ProviderSetupService({
    repository: store.providerReadiness,
    commands: providerCommands,
    home: os.homedir(),
    agentAccess,
  });
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
  // Usage view: indexes ~/.claude/projects and ~/.codex/sessions in the
  // background; nothing here blocks startup.
  const logUsage = (message: string, error?: unknown) => console.error(message, error instanceof Error ? error.message : error ?? '');
  const modelNews = new ModelNewsService({ repository: store.usage, log: logUsage });
  const usageIndexer = new UsageIndexer({ repository: store.usage, log: logUsage, onIndexed: () => modelNews.recordFirstUse() });
  const usageQueries = new UsageQueries({
    repository: store.usage,
    getPricing: () => ({ ...DEFAULT_PRICING, ...config.usagePricing }),
    status: () => ({ indexedAt: usageIndexer.indexedAt, indexing: usageIndexer.indexing }),
  });
  // Issue #91: one Mac window, chosen at the Mac, viewed from a paired owner
  // phone. The capture helper exits with the service (its stdin closes), so
  // a restart never leaves a capture or its indicator behind.
  const captureDriver = nativeCaptureDriver();
  const windowView = new WindowViewService({ driver: captureDriver });
  const app = buildApp({
    config, manager, store, terminals, coordination, vscode, discovery, modelCatalog, workEngine,
    remoteHosts: remoteAccess.hosts, collaborators, ownerPairing,
    phoneAccess: config.launchedByApp ? {
      enabled: () => Boolean(config.phoneAccess),
      set: (enabled) => {
        saveConfig({ phoneAccess: enabled });
        // The Mac app relaunches the service on this exit code, and the new
        // process binds (or skips) the tailnet from the saved choice.
        void close().then(() => process.exit(SERVICE_RESTART_EXIT_CODE));
      },
    } : undefined,
    usage: { queries: usageQueries, indexer: usageIndexer, news: modelNews },
    personalTasks: { service: personalTasks, pickFolder: macFolderPicker() },
    emailTasks: { service: emailTasks },
    routines: { service: routines },
    providerSetup,
    pickAccessFolder: macFolderPicker('Choose a folder AgentDeck may use for your projects'),
    relay,
    windowView: { service: windowView, openSettings: () => captureDriver.openSettings() },
  });
  relay.attach(relayDispatcher(app, ownerPairing));
  const access = folderAccess(config, () => store.listRepos());
  // Ticket 11/12: the same ConnectionTrust.classify() every other route
  // defers to (see app.ts's onRequest hook) — resolves a collaborator
  // device's grants, or undefined (unrestricted) for local and the legacy
  // shared-token remote path.
  const requestTrust = (req: FastifyRequest) => classify(
    { host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER] as string | undefined },
    { remoteHosts: remoteAccess.hosts, token: config.tailscaleToken, deviceLookup: collaborators.resolveDevice, ownerLookup: ownerPairing.resolve.bind(ownerPairing) },
  );
  registerWorkRoutes(app, workEngine, {
    repositoryAllowed: (repositoryId) => {
      const repository = store.listRepos().find((repo) => repo.id === repositoryId);
      return repository === undefined || access.allows(repository.path);
    },
    resolveGrantedRepositoryIds: (req) => requestTrust(req).device?.grantedRepositoryIds,
    resolveActor: (req) => {
      const device = requestTrust(req).device;
      if (device) return toRunActor(device);
      const ownerDevice = requestTrust(req).ownerDevice;
      return ownerDevice ? { principal: resolveLocalPrincipal(), device: ownerDevice } : undefined;
    },
    // B07: reuses the exact identity resolution shared session chat already
    // established (docs/specs/shared-session-chat.md) rather than a second,
    // parallel "who sent this" decision.
    resolveAuthor: (req) => resolveSenderIdentity(requestTrust(req)),
    runFeedbackStore: store,
    runPreviewServer,
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
    usageIndexer.stop(); modelNews.stop();
    companion?.close();
    windowView.shutdown();
    relay.stop();
    providerSetup.shutdown();
    releaseWakeLock();
    await manager.shutdown();
    if (wss) await closeWs(wss);
    if (tailnetServer) await new Promise<void>((resolve) => tailnetServer!.close(() => resolve()));
    await runPreviewServer.close();
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
        runAttention: deriveRunAttentionItems(workEngine.list()),
      };
    }, { remoteHosts: remoteAccess.hosts, token: config.tailscaleToken }, workEngine, collaborators, ownerPairing);

    companion = launchNativeCompanion(port);
    void relay.start();
    discovery.start();
    usageIndexer.start();
    modelNews.start();
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
