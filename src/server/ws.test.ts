// T4 protocol tests: WS bridge + REST routes against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import type { LaunchSpec } from '../types.js';
import type { Handle, SessionBackend } from '../sessions/backend.js';
import { SessionManager } from '../sessions/manager.js';
import { Store } from '../store/index.js';
import { CollaboratorService } from '../collaborators/service.js';
import { defaultConfig } from '../config.js';
import { buildApp, isAllowedOrigin, isLoopbackHostHeader } from './app.js';
import { attachWs, closeWs, getConnectionTrust } from './ws.js';
import { TOKEN_HEADER } from './connection-trust.js';
import type { ServerFrame } from '../protocol.js';
import { TerminalRegistry, VsCodeBridge, type TerminalAdapter } from '../discovery/terminals/index.js';
import { DiscoveryPoller } from '../discovery/poller.js';

/** Scriptable in-memory backend: no real processes. */
class FakeBackend implements SessionBackend {
  private nextPid = 1000;
  emitters = new Map<string, EventEmitter>();
  written = new Map<string, string[]>();
  resized = new Map<string, { cols: number; rows: number }[]>();
  killed = new Map<string, string[]>();
  spawnedSpecs: LaunchSpec[] = [];

  async spawn(spec: LaunchSpec): Promise<Handle> {
    this.spawnedSpecs.push(spec);
    const pid = this.nextPid++;
    const h = { id: String(pid), pid };
    this.emitters.set(h.id, new EventEmitter());
    this.written.set(h.id, []);
    this.resized.set(h.id, []);
    this.killed.set(h.id, []);
    return h;
  }
  write(h: Handle, data: string): void {
    this.written.get(h.id)?.push(data);
  }
  onData(h: Handle, cb: (data: string) => void): void {
    this.emitters.get(h.id)?.on('data', cb);
  }
  onExit(h: Handle, cb: (exitCode: number) => void): void {
    this.emitters.get(h.id)?.on('exit', cb);
  }
  resize(h: Handle, cols: number, rows: number): void {
    this.resized.get(h.id)?.push({ cols, rows });
  }
  async kill(h: Handle, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    this.killed.get(h.id)?.push(signal);
    this.emitters.get(h.id)?.emit('exit', 0); // dies immediately on first signal
  }
  async list(): Promise<Handle[]> {
    return [];
  }
  /** test helper: simulate child output */
  emitOutput(pid: number, data: string): void {
    this.emitters.get(String(pid))?.emit('data', data);
  }
}

class FakeVsCodeAdapter implements TerminalAdapter {
  readonly app = 'VSCode' as const;
  readonly verified = true;
  readonly focus = vi.fn(async () => undefined);
  readonly sendText = vi.fn(async () => undefined);
  async listTtys() { return []; }
}

/** WS test client that queues received frames. */
class Client {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => this.frames.push(JSON.parse(String(raw))));
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }
  async waitFor<T extends ServerFrame['t']>(t: T, ms = 3000): Promise<ServerFrame & { t: T }> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.frames.find((f) => f.t === t);
      if (hit) return hit as ServerFrame & { t: T };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${t} frame within ${ms}ms; got ${JSON.stringify(this.frames.map((f) => f.t))}`);
  }
  close(): void {
    this.ws.close();
  }
}

let backend: FakeBackend;
let store: Store;
let manager: SessionManager;
let sessionsDir: string;
let app: ReturnType<typeof buildApp>;
let wss: WebSocketServer;
let port: number;
let vscode: VsCodeBridge;
let vscodeAdapter: FakeVsCodeAdapter;
let installVsCode: ReturnType<typeof vi.fn>;
let discovery: DiscoveryPoller;
const clients: Client[] = [];

beforeEach(async () => {
  backend = new FakeBackend();
  store = new Store(':memory:');
  // POST /api/sessions launches through the real SessionManager below, and
  // every launch now spills output to sessionsDir/<id>/raw.log — point that
  // at a throwaway tmpdir so these tests never touch the real ~/.agentdeck.
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-sessions-'));
  manager = new SessionManager(backend, store, { sessionsDir });
  vscode = new VsCodeBridge();
  vscodeAdapter = new FakeVsCodeAdapter();
  installVsCode = vi.fn(async () => ({ installed: true as const, reloadRequired: true as const }));
  discovery = new DiscoveryPoller({
    store,
    getManagedPids: () => new Set(),
    publish: vi.fn(),
    remove: vi.fn(),
    run: vi.fn(async () => ''),
  });
  app = buildApp({
    config: defaultConfig(), manager, store, vscode,
    terminals: new TerminalRegistry([vscodeAdapter]), installVsCode, discovery,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  wss = attachWs([app.server], manager, '/ws', vscode, () => ({
    sessions: manager.listSessions(),
    attention: [],
    agents: [],
    runAttention: [],
  }));
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterEach(async () => {
  while (clients.length) clients.pop()?.close();
  await closeWs(wss);
  await app.close();
  // Stop (and compact) any sessions still live from the test before wiping
  // sessionsDir — otherwise a still-in-flight raw.log spill can race the
  // directory removal below.
  await manager.shutdown();
  store.close();
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const c = new Client(port);
  clients.push(c);
  await c.open();
  return c;
}

const SPEC = { agent: 'claude', cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-')) };

async function launchViaRest(): Promise<{ id: string; pid: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(SPEC),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('REST routes', () => {
  it('reports discovery health and supports an immediate refresh', async () => {
    const initial = await (await fetch(`http://127.0.0.1:${port}/api/discovery/status`)).json();
    expect(initial).toMatchObject({ running: false, polling: false, detectedProcesses: 0 });

    const refreshed = await fetch(`http://127.0.0.1:${port}/api/discovery/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      polling: false, detectedProcesses: 0, publishedSessions: 0,
    });
  });

  it('reports, installs, and registers the VS Code helper', async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/api/integrations/vscode/status`)).json())
      .toMatchObject({ connected: false, windows: 0, terminals: 0 });
    const installed = await fetch(`http://127.0.0.1:${port}/api/integrations/vscode/install`, { method: 'POST' });
    expect(await installed.json()).toEqual({ installed: true, reloadRequired: true });
    expect(installVsCode).toHaveBeenCalledOnce();

    const client = await connect();
    client.send({
      t: 'vscode_register', windowId: 'window-1',
      terminals: [{ id: 'term-1', name: 'Agent', processId: 123 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await (await fetch(`http://127.0.0.1:${port}/api/integrations/vscode/status`)).json())
      .toMatchObject({ connected: true, windows: 1, terminals: 1 });
  });

  it('POST /api/sessions launches and GET lists it', async () => {
    const created = await launchViaRest();
    expect(created.pid).toBe(1000);
    expect(backend.spawnedSpecs[0]?.env?.AGENTDECK_SESSION_ID).toBe(created.id);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    expect(list.map((s: { id: string }) => s.id)).toContain(created.id);
  });

  it('exposes and broadcasts the native companion snapshot', async () => {
    const client = await connect();
    const initial = await client.waitFor('companion_snapshot');
    expect(initial.snapshot).toMatchObject({ sessions: [], attention: [], agents: [], uiVisible: false });

    const response = await fetch(`http://127.0.0.1:${port}/api/companion`);
    expect(await response.json()).toMatchObject({ sessions: [], attention: [], agents: [], uiVisible: false });
  });

  it('returns structured launcher preflight checks', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/launch/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', cwd: '/definitely/missing/agentdeck', branch: 'feature' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ready: boolean; checks: { label: string; ok: boolean }[] };
    expect(body.ready).toBe(false);
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Working directory found', ok: false }),
      expect.objectContaining({ label: 'Repository available', ok: false }),
      expect.objectContaining({ label: 'Branch available', ok: false }),
    ]));
  });

  it('never returns or broadcasts private launch data', async () => {
    const client = await connect();
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...SPEC,
        initialPrompt: 'private prompt',
        extraArgs: ['--private-argument'],
        env: { API_TOKEN: 'private-token' },
      }),
    });
    const created = await response.json() as Record<string, unknown>;
    expect(created.launchSpec).toBeUndefined();
    expect(store.getSession(String(created.id))?.launchSpec).toBeUndefined();
    const update = await client.waitFor('session_update');
    expect(update.session.launchSpec).toBeUndefined();
    const listed = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json() as Record<string, unknown>[];
    expect(listed.find((session) => session.id === created.id)?.launchSpec).toBeUndefined();
  });

  it('POST /api/sessions rejects bad specs', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'gpt', cwd: '/tmp' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/sessions maps permissionMode to --permission-mode for claude', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SPEC, permissionMode: 'plan' }),
    });
    expect(res.status).toBe(201);
    const spawned = backend.spawnedSpecs.at(-1);
    expect(spawned?.extraArgs).toEqual(['--permission-mode', 'plan']);
  });

  it('POST /api/sessions maps Ask to read-only on-request permissions for codex', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SPEC, agent: 'codex', permissionMode: 'default' }),
    });
    expect(res.status).toBe(201);
    const spawned = backend.spawnedSpecs.at(-1);
    expect(spawned?.extraArgs?.slice(0, 4)).toEqual([
      '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
    ]);
  });

  it('POST /api/sessions maps Auto-edit to workspace-write on-request permissions for codex', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SPEC, agent: 'codex', permissionMode: 'acceptEdits' }),
    });
    expect(res.status).toBe(201);
    const spawned = backend.spawnedSpecs.at(-1);
    expect(spawned?.extraArgs?.slice(0, 4)).toEqual([
      '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    ]);
  });

  it('POST /api/sessions starts codex Plan mode with the initial prompt', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...SPEC, agent: 'codex', permissionMode: 'plan', initialPrompt: 'Design the migration',
      }),
    });
    expect(res.status).toBe(201);
    expect(backend.spawnedSpecs.at(-1)?.initialPrompt).toBe('/plan Design the migration');
  });

  it('POST /api/sessions starts codex Plan mode without an initial prompt', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SPEC, agent: 'codex', permissionMode: 'plan' }),
    });
    expect(res.status).toBe(201);
    expect(backend.spawnedSpecs.at(-1)?.initialPrompt).toBe('/plan');
  });

  it('POST /api/sessions rejects an invalid permissionMode', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SPEC, permissionMode: 'bypassPermissions' }),
    });
    expect(res.status).toBe(400);
  });

  it('stop ends the session in place (ticket 04: kept, not removed) and broadcasts session_update', async () => {
    const c = await connect();
    const { id } = await launchViaRest();
    const stopRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: 'POST' });
    expect(await stopRes.json()).toEqual({ ok: true });
    expect(backend.killed.get('1000')).toEqual(['SIGTERM']);

    // Launch itself already produced earlier session_update frames (status
    // starting/working); wait specifically for the one reporting the end.
    const isEndedUpdate = (f: ServerFrame): f is ServerFrame & { t: 'session_update' } =>
      f.t === 'session_update' && f.session.id === id && f.session.status === 'exited';
    const t0 = Date.now();
    let updateFrame = c.frames.find(isEndedUpdate);
    while (!updateFrame && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 10));
      updateFrame = c.frames.find(isEndedUpdate);
    }
    if (!updateFrame) throw new Error('no exited session_update frame within 3000ms');
    expect(updateFrame.session.endedAt).toBeDefined();

    // Still listed, now ended — this is what "kept, not removed" means.
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: 'exited' });

    // Stopping again is a live-only action; the session has already ended.
    const again = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: 'POST' });
    expect(again.status).toBe(400);
  });

  it('ticket 09: an ended session is readable via GET .../scrollback, and it survives a fresh readScrollback() read (independent of the live manager)', async () => {
    const { id, pid } = await launchViaRest();
    backend.emitOutput(pid, 'agent output before exit\r\n');
    await new Promise((r) => setTimeout(r, 30)); // let the coalescing timer spill it to raw.log

    // POST /stop already awaits manager.stop(), which now awaits compaction
    // (ticket 09) — by the time this resolves, scrollback.txt exists.
    const stopRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/scrollback`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; scrollback: string };
    expect(body.sessionId).toBe(id);
    expect(body.scrollback).toContain('agent output before exit');

    // Reading it back through a brand-new SessionTranscript helper call
    // (not through the live `manager`) is the same thing a restarted server
    // would do — scrollback survives independent of any in-memory state.
    const { readScrollback } = await import('../sessions/transcript.js');
    expect(await readScrollback(sessionsDir, id)).toContain('agent output before exit');
  });

  it('scrollback 404s for a session that has never been launched, and for a still-live one', async () => {
    const missing = await fetch(`http://127.0.0.1:${port}/api/sessions/does-not-exist/scrollback`);
    expect(missing.status).toBe(404);

    const { id } = await launchViaRest();
    const stillLive = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/scrollback`);
    expect(stillLive.status).toBe(404);
    expect((await stillLive.json()).error).toMatch(/still running/);
  });

  it('POST /api/sessions/:id/send types into managed sessions and queues for unscriptable claude', async () => {
    const { id } = await launchViaRest();
    const send = (target: string, text: string) => fetch(`http://127.0.0.1:${port}/api/sessions/${target}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const typed = await send(id, 'run the tests');
    expect(((await typed.json()) as { delivered: string }).delivered).toBe('typed');
    await new Promise((r) => setTimeout(r, 400));
    expect(backend.written.get('1000')).toEqual(['run the tests', '\r']);
    // every successful send lands on the repo bus for the message history
    expect(fs.readFileSync(path.join(SPEC.cwd, '.agents', 'bus.jsonl'), 'utf8'))
      .toContain(`"agent":"dashboard:${id}"`);

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-send-'));
    const base = {
      cwd: repoDir,
      startedAt: '2026-07-17T00:00:00.000Z',
      lastActivityAt: '2026-07-17T00:00:00.000Z',
      status: 'idle',
      statusSource: 'cpu_heuristic',
      terminalApp: 'unknown',
    } as const;
    store.upsertSession({
      ...base, id: 'ext-1-1', origin: 'external', agent: 'claude',
      agentSessionId: 'claude:s-1',
    });
    const queued = await send('ext-1-1', 'hello from the deck');
    expect(await queued.json()).toMatchObject({ delivered: 'queued', hooked: false });
    expect(fs.readFileSync(path.join(repoDir, '.agents', 'inbox.jsonl'), 'utf8'))
      .toContain('"to":"claude:s-1"');
    expect(fs.readFileSync(path.join(repoDir, '.agents', 'bus.jsonl'), 'utf8')).toContain('"agent":"dashboard:ext-1-1"');

    const messagesUrl = `http://127.0.0.1:${port}/api/sessions/ext-1-1/messages`;
    expect(await (await fetch(`http://127.0.0.1:${port}/api/sessions/ext-1-1/capabilities`)).json())
      .toEqual({ send: 'queued', replyCapture: false });
    expect(await (await fetch(messagesUrl)).json()).toEqual([
      expect.objectContaining({ agent: 'dashboard:ext-1-1', event: 'message', message: 'hello from the deck' }),
    ]);

    fs.appendFileSync(path.join(repoDir, '.agents', 'bus.jsonl'), `${JSON.stringify({
      ts: '2026-07-17T00:01:00.000Z', agent: 'claude:s-1', repo: repoDir, event: 'done', message: 'Finished the task.',
    })}\n`);
    store.upsertSession({
      ...base, id: 'ext-3-3', origin: 'external', agent: 'claude',
      agentSessionId: 'claude:s-2',
    });
    fs.appendFileSync(path.join(repoDir, '.agents', 'bus.jsonl'), [
      JSON.stringify({
        ts: '2026-07-17T00:02:00.000Z', agent: 'dashboard:ext-3-3', repo: repoDir,
        event: 'message', message: 'Other terminal question.',
      }),
      JSON.stringify({
        ts: '2026-07-17T00:03:00.000Z', agent: 'claude:s-2', repo: repoDir,
        event: 'done', message: 'Other terminal answer.',
      }),
      '',
    ].join('\n'));
    expect(await (await fetch(messagesUrl)).json()).toEqual([
      expect.objectContaining({ agent: 'dashboard:ext-1-1', event: 'message', message: 'hello from the deck' }),
      expect.objectContaining({ agent: 'claude:s-1', event: 'done', message: 'Finished the task.' }),
    ]);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/sessions/ext-3-3/messages`)).json()).toEqual([
      expect.objectContaining({ agent: 'dashboard:ext-3-3', message: 'Other terminal question.' }),
      expect.objectContaining({ agent: 'claude:s-2', message: 'Other terminal answer.' }),
    ]);

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-send-empty-'));
    store.upsertSession({ ...base, cwd: emptyDir, id: 'ext-empty', origin: 'external', agent: 'claude' });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/sessions/ext-empty/messages`)).json()).toEqual([]);
    expect((await send('ext-empty', 'must not leak')).status).toBe(409);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions/missing/messages`)).status).toBe(404);

    // once AgentDeck hooks exist in the repo, queued sends report hooked: true
    fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node agentdeck-hook.mjs"}]}]}}');
    expect(await (await send('ext-1-1', 'second')).json()).toMatchObject({ delivered: 'queued', hooked: true });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/sessions/ext-1-1/capabilities`)).json())
      .toEqual({ send: 'queued', replyCapture: true });

    store.upsertSession({ ...base, id: 'ext-2-2', origin: 'external', agent: 'codex' });
    expect((await send('ext-2-2', 'hi')).status).toBe(400);
    store.upsertSession({
      ...base, id: 'ext-vscode', origin: 'external', agent: 'codex', terminalApp: 'VSCode',
      terminalRef: { windowId: 'window-1', tabId: 'term-1' },
    });
    expect(await (await send('ext-vscode', 'hello codex')).json()).toEqual({ delivered: 'typed' });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/sessions/ext-vscode/capabilities`)).json())
      .toMatchObject({ send: 'vscode' });
    expect(vscodeAdapter.sendText).toHaveBeenCalledWith(
      { windowId: 'window-1', tabId: 'term-1' }, 'hello codex',
    );
    expect((await send(id, '   ')).status).toBe(400);
  });

  it('restart respawns a live session with a fresh pid, same id', async () => {
    const { id } = await launchViaRest();
    const restartRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/restart`, { method: 'POST' });
    const restarted = (await restartRes.json()) as { id: string; pid: number };
    expect(restarted.id).toBe(id);
    expect(restarted.pid).toBe(1001); // fresh fake pid
  });

  it('PATCH /api/sessions/:id persists an inline label', async () => {
    const { id } = await launchViaRest();
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Payments migration' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, name: 'Payments migration' });
    expect(store.getSession(id)?.name).toBe('Payments migration');
  });
});

describe('loopback-only enforcement', () => {
  it('accepts only loopback Host headers and Origins', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4040')).toBe(true);
    expect(isLoopbackHostHeader('localhost:4040')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4040')).toBe(true);
    expect(isLoopbackHostHeader('evil.example')).toBe(false);
    expect(isLoopbackHostHeader('evil.example:4040')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);

    expect(isAllowedOrigin(undefined)).toBe(true); // curl / CLI clients
    expect(isAllowedOrigin(`http://127.0.0.1:4040`)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4040', '127.0.0.1:4040')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4041', '127.0.0.1:4040')).toBe(false);
    expect(isAllowedOrigin('http://localhost:4040', '127.0.0.1:4040')).toBe(false);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('file:///tmp/index.html')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('rejects cross-origin REST requests and WebSocket upgrades', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);

    const otherLocalSite = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: `http://127.0.0.1:${port + 1}` },
    });
    expect(otherLocalSite.status).toBe(403);

    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const rejected = await new Promise<boolean>((resolve) => {
      evil.once('error', () => resolve(true));
      evil.once('open', () => resolve(false));
    });
    evil.terminate();
    expect(rejected).toBe(true);
  });
});

describe('WS protocol', () => {
  it('keeps replay, output, and input isolated when one viewer attaches multiple sessions', async () => {
    const first = await launchViaRest();
    const second = await launchViaRest();
    backend.emitOutput(first.pid, 'first replay');
    backend.emitOutput(second.pid, 'second replay');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = await connect();
    client.frames = [];
    client.send({ t: 'attach', sessionId: first.id });
    client.send({ t: 'attach', sessionId: second.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.frames.filter((frame) => frame.t === 'replay')).toEqual([
      { t: 'replay', sessionId: first.id, data: 'first replay' },
      { t: 'replay', sessionId: second.id, data: 'second replay' },
    ]);

    backend.emitOutput(first.pid, 'first live');
    backend.emitOutput(second.pid, 'second live');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.frames.filter((frame) => frame.t === 'output')).toEqual([
      { t: 'output', sessionId: first.id, data: 'first live' },
      { t: 'output', sessionId: second.id, data: 'second live' },
    ]);

    client.send({ t: 'input', sessionId: first.id, data: 'first input\r' });
    client.send({ t: 'input', sessionId: second.id, data: 'second input\r' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.written.get(String(first.pid))).toEqual(['first input\r']);
    expect(backend.written.get(String(second.pid))).toEqual(['second input\r']);
  });

  it('attach replays the ring buffer', async () => {
    const { id, pid } = await launchViaRest();
    backend.emitOutput(pid, 'earlier output\r\n');
    const c = await connect();
    c.send({ t: 'attach', sessionId: id });
    const replay = await c.waitFor('replay');
    expect(replay.data).toContain('earlier output');
  });

  it('streams output to every attached viewer, not to detached ones', async () => {
    const { id, pid } = await launchViaRest();
    const [a, b, unattached] = [await connect(), await connect(), await connect()];
    a.send({ t: 'attach', sessionId: id });
    b.send({ t: 'attach', sessionId: id });
    await a.waitFor('replay');
    await b.waitFor('replay');

    backend.emitOutput(pid, 'live-data');
    expect((await a.waitFor('output')).data).toBe('live-data');
    expect((await b.waitFor('output')).data).toBe('live-data');
    expect(unattached.frames.filter((f) => f.t === 'output')).toHaveLength(0);

    a.send({ t: 'detach', sessionId: id });
    await new Promise((r) => setTimeout(r, 50));
    backend.emitOutput(pid, 'after-detach');
    expect((await b.waitFor('output', 1000)) /* b still gets it */).toBeTruthy();
    expect(a.frames.filter((f) => f.t === 'output').map((f) => f.data)).toEqual(['live-data']);
  });

  it('input reaches the backend; a resize frame from a viewer never does', async () => {
    const { id } = await launchViaRest();
    const c = await connect();
    c.send({ t: 'attach', sessionId: id });
    await c.waitFor('replay');
    c.send({ t: 'input', sessionId: id, data: 'ls\r' });
    // Terminal size is pinned (Stage 2): a resize frame from a viewer must
    // never reach backend.resize, no matter what the client sends.
    c.send({ t: 'resize', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.written.get('1000')).toEqual(['ls\r']);
    expect(backend.resized.get('1000')).toEqual([]);
  });

  // ticket 14 regression: the raw-write allowlist applies only to
  // connections lacking the 'raw-write' capability. A 'local' connection
  // (the default for these tests — loopback host, no tailnet trust config)
  // must keep sending arbitrary raw bytes exactly as before.
  it('ticket 14: a local connection\'s arbitrary printable text is unaffected by the remote allowlist', async () => {
    const { id, pid } = await launchViaRest();
    const c = await connect();
    c.send({ t: 'attach', sessionId: id });
    await c.waitFor('replay');
    c.send({ t: 'input', sessionId: id, data: 'echo hello world && rm -rf /tmp/whatever\r' });
    c.send({ t: 'input', sessionId: id, data: '\x1b[Aextra-bytes-a-remote-connection-could-never-send' });
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.written.get(String(pid))).toEqual([
      'echo hello world && rm -rf /tmp/whatever\r',
      '\x1b[Aextra-bytes-a-remote-connection-could-never-send',
    ]);
  });

  it('broadcasts session_update to all sockets on status change', async () => {
    const c = await connect();
    const { id, pid } = await launchViaRest();
    backend.emitOutput(pid, 'some ❯ readiness output');
    const update = await c.waitFor('session_update');
    expect(update.session.id).toBe(id);
  });

  it('ignores malformed frames and attach to unknown sessions', async () => {
    const c = await connect();
    c.send({ t: 'attach', sessionId: 'does-not-exist' });
    c.ws.send('not json at all');
    c.send({ t: 'resize', cols: -5, rows: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.frames.filter((frame) => frame.t === 'replay')).toHaveLength(0);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('pushes tile_preview to every socket, not just attached viewers', async () => {
    const { id, pid } = await launchViaRest();
    const [viewer, other] = [await connect(), await connect()];
    viewer.send({ t: 'attach', sessionId: id });
    await viewer.waitFor('replay');
    // both sockets already received a (empty) seed tile_preview on connect;
    // wait specifically for the live chunk pushed after emitOutput below.
    const waitForData = async (client: Client, data: string) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const hit = client.frames.find((f) => f.t === 'tile_preview' && f.data === data);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no tile_preview with data ${data} within 3000ms`);
    };

    backend.emitOutput(pid, 'grid-tile-data');
    await waitForData(viewer, 'grid-tile-data');
    const otherPreview = await waitForData(other, 'grid-tile-data');
    expect(otherPreview).toEqual({ t: 'tile_preview', sessionId: id, data: 'grid-tile-data', seed: false });
  });

  it('seeds a newly connected socket with each managed session\'s buffer', async () => {
    const { id, pid } = await launchViaRest();
    backend.emitOutput(pid, 'earlier tile output');
    await new Promise((r) => setTimeout(r, 50));

    const late = await connect();
    const seed = await late.waitFor('tile_preview');
    expect(seed).toEqual({ t: 'tile_preview', sessionId: id, data: 'earlier tile output', seed: true });
  });

  it('does not push tile_preview frames for external sessions', async () => {
    const c = await connect();
    store.upsertSession({
      id: 'ext-grid-1',
      origin: 'external',
      agent: 'claude',
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-ext-')),
      startedAt: '2026-07-17T00:00:00.000Z',
      lastActivityAt: '2026-07-17T00:00:00.000Z',
      status: 'idle',
      statusSource: 'cpu_heuristic',
      terminalApp: 'unknown',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.filter((f) => f.t === 'tile_preview' && f.sessionId === 'ext-grid-1')).toHaveLength(0);
  });

  it('broadcasts aggregate browser visibility to companion clients', async () => {
    const browser = await connect();
    const companion = await connect();
    browser.frames = [];
    companion.frames = [];
    browser.send({ t: 'ui_presence', visible: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(companion.frames.filter((frame) => frame.t === 'ui_presence').at(-1))
      .toEqual({ t: 'ui_presence', visible: true });
    browser.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(companion.frames.filter((frame) => frame.t === 'ui_presence').at(-1))
      .toEqual({ t: 'ui_presence', visible: false });
  });
});

// ticket 05: a live WS client actually holding a connection, not just an
// HTTP page load — this is the acceptance line "verified by a remote client
// holding a live connection rather than only loading the page." A real
// tailnet interface isn't available in this sandbox, so "remote" is
// simulated by connecting to the loopback-bound test server while sending a
// Host header equal to the configured tailnet hostname (`ws` forwards a
// caller-supplied `Host` header as-is) — classify() only ever looks at the
// Host header string, so this exercises the exact same code path a real
// second bind would.
describe('remote (tailnet) WebSocket access', () => {
  const REMOTE_HOST = 'phone-test-host.tailnet-1234.ts.net';
  const REMOTE_IP = '100.101.102.103';
  const TOKEN = 'a-real-remote-access-token-0123456789';

  let remoteStore: Store;
  let remoteManager: SessionManager;
  let remoteBackend: FakeBackend;
  let remoteSessionsDir: string;
  let remoteApp: ReturnType<typeof buildApp>;
  let remoteWss: WebSocketServer;
  let remotePort: number;

  beforeEach(async () => {
    remoteStore = new Store(':memory:');
    remoteSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-remote-'));
    remoteBackend = new FakeBackend();
    remoteManager = new SessionManager(remoteBackend, remoteStore, { sessionsDir: remoteSessionsDir });
    remoteApp = buildApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN },
      manager: remoteManager,
      store: remoteStore,
      remoteHosts: [REMOTE_HOST, REMOTE_IP],
    });
    await remoteApp.listen({ port: 0, host: '127.0.0.1' });
    remoteWss = attachWs(
      [remoteApp.server], remoteManager, '/ws', undefined, undefined,
      { remoteHosts: [REMOTE_HOST, REMOTE_IP], token: TOKEN },
    );
    const addr = remoteApp.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    remotePort = addr.port;
  });

  afterEach(async () => {
    await closeWs(remoteWss);
    await remoteApp.close();
    await remoteManager.shutdown();
    remoteStore.close();
    fs.rmSync(remoteSessionsDir, { recursive: true, force: true });
  });

  async function launchViaRemoteRest(): Promise<{ id: string; pid: number }> {
    const res = await fetch(`http://127.0.0.1:${remotePort}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SPEC),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  /** Opens an authenticated remote (tailnet-host + valid token) WS client. */
  async function connectRemote(): Promise<WebSocket> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${remotePort}/ws?token=${encodeURIComponent(TOKEN)}`,
      { headers: { host: REMOTE_HOST } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }

  it('accepts a loopback connection with no token at all', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${remotePort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(getConnectionTrust(ws as unknown as import('ws').WebSocket)).toBeUndefined(); // this is the client-side socket, not the server's
    ws.close();
  });

  it('refuses a tailnet-host upgrade with no token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${remotePort}/ws`, { headers: { host: REMOTE_HOST } });
    const rejected = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true));
      ws.once('open', () => resolve(false));
    });
    ws.terminate();
    expect(rejected).toBe(true);
  });

  it('refuses a tailnet-host upgrade with the wrong token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${remotePort}/ws?token=wrong-token`, { headers: { host: REMOTE_HOST } });
    const rejected = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true));
      ws.once('open', () => resolve(false));
    });
    ws.terminate();
    expect(rejected).toBe(true);
  });

  it('accepts a tailnet-host upgrade with the correct token, and the resulting classification is retrievable server-side', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${remotePort}/ws?token=${encodeURIComponent(TOKEN)}`,
      { headers: { host: REMOTE_HOST } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // A live connection, not just a successful handshake: round-trip an
    // actual protocol frame over it.
    const framesReceived: unknown[] = [];
    ws.on('message', (raw) => framesReceived.push(JSON.parse(String(raw))));
    ws.send(JSON.stringify({ t: 'attach', sessionId: 'does-not-exist' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    let serverSocket: import('ws').WebSocket | undefined;
    for (const client of remoteWss.clients) serverSocket = client;
    expect(serverSocket).toBeDefined();
    const trust = getConnectionTrust(serverSocket!);
    expect(trust).toEqual({ kind: 'remote', capabilities: new Set(['view', 'compose', 'control-keys']) });
    expect(trust?.capabilities.has('raw-write')).toBe(false);

    ws.close();
  });

  it('accepts the bound raw tailnet IP for a same-origin authenticated upgrade', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${remotePort}/ws?token=${encodeURIComponent(TOKEN)}`,
      { headers: { host: REMOTE_IP, origin: `http://${REMOTE_IP}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // ticket 14: raw-write refusal for remote connections, verified by a raw
  // WS client that bypasses the UI entirely — the acceptance line "verified
  // by a request that bypasses the UI."
  it('lets a remote connection send Ctrl-C through to the backend', async () => {
    const { id, pid } = await launchViaRemoteRest();
    const ws = await connectRemote();
    ws.send(JSON.stringify({ t: 'attach', sessionId: id }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ t: 'input', sessionId: id, data: '\x03' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(remoteBackend.written.get(String(pid))).toEqual(['\x03']);
    ws.close();
  });

  it('refuses arbitrary printable text sent by a remote connection — it never reaches the backend', async () => {
    const { id, pid } = await launchViaRemoteRest();
    const ws = await connectRemote();
    ws.send(JSON.stringify({ t: 'attach', sessionId: id }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ t: 'input', sessionId: id, data: 'rm -rf /\r' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(remoteBackend.written.get(String(pid))).toEqual([]);
    ws.close();
  });

  // ticket 14 acceptance line: "Free-text messages continue to work from a
  // phone." This route (routes.ts POST /api/sessions/:id/send) isn't
  // changed by this ticket — ticket 05's onRequest gate already covers it —
  // this just confirms an authenticated remote request still succeeds.
  it('POST /api/sessions/:id/send still succeeds for an authenticated remote request', async () => {
    const { id } = await launchViaRemoteRest();
    const response = await remoteApp.inject({
      method: 'POST',
      url: `/api/sessions/${id}/send`,
      headers: {
        host: `${REMOTE_HOST}:1234`,
        [TOKEN_HEADER]: TOKEN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ text: 'hello from a phone' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ delivered: 'typed' });
  });

  // Code-review finding: POST .../send writes `text` verbatim to the PTY,
  // and this route is reachable by an authenticated remote connection
  // (confirmed above) — without a check here, a remote client could
  // smuggle raw control bytes through the composer, bypassing the WS
  // 'input' path's control-key allowlist through a different door. This
  // proves the closed bypass end-to-end: the byte never reaches the
  // backend, and the same request from a local connection is unaffected.
  it('refuses control bytes smuggled through POST /send on a remote connection — they never reach the backend', async () => {
    const { id, pid } = await launchViaRemoteRest();
    const response = await remoteApp.inject({
      method: 'POST',
      url: `/api/sessions/${id}/send`,
      headers: { host: `${REMOTE_HOST}:1234`, [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'please continue\x03' }),
    });
    expect(response.statusCode).toBe(400);
    expect(remoteBackend.written.get(String(pid)) ?? []).toEqual([]);
  });

  it('the same control-byte text via POST /send still succeeds on a local (loopback) connection — unaffected', async () => {
    const { id, pid } = await launchViaRemoteRest();
    const response = await remoteApp.inject({
      method: 'POST',
      url: `/api/sessions/${id}/send`,
      headers: { host: '127.0.0.1:1234', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'please continue\x03' }),
    });
    expect(response.statusCode).toBe(200);
    expect(remoteBackend.written.get(String(pid))).toContain('please continue\x03');
  });

  it('withholds external-session updates and refuses external attach for remote sockets', async () => {
    const external = {
      id: 'external-phone-hidden', origin: 'external' as const, agent: 'claude' as const,
      cwd: '/tmp', startedAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T00:00:00.000Z',
      status: 'working' as const, statusSource: 'cpu_heuristic' as const, terminalApp: 'Terminal' as const,
    };
    remoteStore.upsertSession(external);
    const ws = await connectRemote();
    const frames: ServerFrame[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));

    remoteManager.publishSessionUpdate(external);
    ws.send(JSON.stringify({ t: 'attach', sessionId: external.id }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(frames.some((frame) => frame.t === 'session_update' && frame.session.id === external.id)).toBe(false);
    expect(frames.some((frame) => (frame.t === 'replay' || frame.t === 'reflow_text') && frame.sessionId === external.id)).toBe(false);
    ws.close();
  });

  // Ticket 13: the mobile reflow view. `attach` behaves completely
  // differently depending on ConnectionTrust's classification of the
  // socket — these tests exercise both branches against the same
  // tailnet-token-configured server used above.
  describe('ticket 13: live reflow view', () => {
    function connectLocal(): WebSocket {
      return new WebSocket(`ws://127.0.0.1:${remotePort}/ws`);
    }
    function connectRemote(): WebSocket {
      return new WebSocket(
        `ws://127.0.0.1:${remotePort}/ws?token=${encodeURIComponent(TOKEN)}`,
        { headers: { host: REMOTE_HOST } },
      );
    }
    function collectFrames(ws: WebSocket): ServerFrame[] {
      const frames: ServerFrame[] = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
      return frames;
    }
    function opened(ws: WebSocket): Promise<void> {
      return new Promise((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
    }
    async function waitForFrame<T extends ServerFrame['t']>(
      frames: ServerFrame[], t: T, ms = 3000,
    ): Promise<ServerFrame & { t: T }> {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = frames.find((f) => f.t === t);
        if (hit) return hit as ServerFrame & { t: T };
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${t} frame within ${ms}ms; got ${JSON.stringify(frames.map((f) => f.t))}`);
    }

    it('a local (loopback) connection still gets replay + raw output frames, byte-for-byte unchanged, even with a tailnet token configured', async () => {
      const { id, pid } = await launchViaRemoteRest();
      const ws = connectLocal();
      const frames = collectFrames(ws);
      await opened(ws);
      ws.send(JSON.stringify({ t: 'attach', sessionId: id }));
      const replay = await waitForFrame(frames, 'replay');
      expect(replay).toEqual({ t: 'replay', sessionId: id, data: '' });

      remoteBackend.emitOutput(pid, 'local sees raw bytes');
      const output = await waitForFrame(frames, 'output');
      expect(output).toEqual({ t: 'output', sessionId: id, data: 'local sees raw bytes' });
      expect(frames.some((f) => f.t === 'reflow_text')).toBe(false);

      ws.close();
    });

    it('a remote (token-authenticated) connection gets reflow_text frames instead of replay/output, and never raw output', async () => {
      const { id, pid } = await launchViaRemoteRest();
      remoteBackend.emitOutput(pid, 'agent output for the phone view\r\n');
      await new Promise((r) => setTimeout(r, 30)); // let the coalescing timer land it in the transcript

      const ws = connectRemote();
      const frames = collectFrames(ws);
      await opened(ws);
      ws.send(JSON.stringify({ t: 'attach', sessionId: id }));

      const reflow = await waitForFrame(frames, 'reflow_text');
      expect(reflow.sessionId).toBe(id);
      expect(reflow.text).toContain('agent output for the phone view');

      remoteBackend.emitOutput(pid, 'more output, still no raw frame');
      await new Promise((r) => setTimeout(r, 100));
      expect(frames.some((f) => f.t === 'replay')).toBe(false);
      expect(frames.some((f) => f.t === 'output')).toBe(false);

      ws.close();
    });

    it('detaching a remote viewer stops further reflow_text frames for that session', async () => {
      const { id, pid } = await launchViaRemoteRest();
      const ws = connectRemote();
      const frames = collectFrames(ws);
      await opened(ws);
      ws.send(JSON.stringify({ t: 'attach', sessionId: id }));
      await waitForFrame(frames, 'reflow_text');

      ws.send(JSON.stringify({ t: 'detach', sessionId: id }));
      await new Promise((r) => setTimeout(r, 50));
      frames.length = 0;
      remoteBackend.emitOutput(pid, 'more output after detach');
      await new Promise((r) => setTimeout(r, 1300)); // longer than LiveReflow's ~1s tick
      expect(frames.filter((f) => f.t === 'reflow_text')).toHaveLength(0);

      ws.close();
    }, 10_000);

    it('closing a remote socket stops its own reflow subscription without disrupting another viewer on the same session', async () => {
      const { id, pid } = await launchViaRemoteRest();
      const wsA = connectRemote();
      const wsB = connectRemote();
      const framesA = collectFrames(wsA);
      const framesB = collectFrames(wsB);
      await Promise.all([opened(wsA), opened(wsB)]);
      wsA.send(JSON.stringify({ t: 'attach', sessionId: id }));
      wsB.send(JSON.stringify({ t: 'attach', sessionId: id }));
      await waitForFrame(framesA, 'reflow_text');
      await waitForFrame(framesB, 'reflow_text');

      wsA.close();
      await new Promise((r) => setTimeout(r, 50));
      framesB.length = 0;
      remoteBackend.emitOutput(pid, 'still live for B');
      await new Promise((r) => setTimeout(r, 1300)); // wait past the next shared tick
      expect(framesB.some((f) => f.t === 'reflow_text')).toBe(true);

      wsB.close();
    }, 10_000);
  });
});

describe('collaborator device WebSocket access (ticket 11)', () => {
  const REMOTE_HOST = 'phone-test-host.tailnet-1234.ts.net';

  let collabStore: Store;
  let collabManager: SessionManager;
  let collabBackend: FakeBackend;
  let collabSessionsDir: string;
  let collabApp: ReturnType<typeof buildApp>;
  let collabWss: WebSocketServer;
  let collaborators: CollaboratorService;
  let collabPort: number;

  beforeEach(async () => {
    collabStore = new Store(':memory:');
    collabSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-collab-'));
    collabBackend = new FakeBackend();
    collabManager = new SessionManager(collabBackend, collabStore, { sessionsDir: collabSessionsDir });
    collaborators = new CollaboratorService(collabStore);
    collabApp = buildApp({
      config: { ...defaultConfig() },
      manager: collabManager,
      store: collabStore,
      remoteHosts: [REMOTE_HOST],
      collaborators,
    });
    await collabApp.listen({ port: 0, host: '127.0.0.1' });
    collabWss = attachWs(
      [collabApp.server], collabManager, '/ws', undefined, undefined,
      { remoteHosts: [REMOTE_HOST] }, undefined, collaborators,
    );
    const addr = collabApp.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    collabPort = addr.port;
  });

  afterEach(async () => {
    await closeWs(collabWss);
    await collabApp.close();
    await collabManager.shutdown();
    collabStore.close();
    fs.rmSync(collabSessionsDir, { recursive: true, force: true });
  });

  function issueDeviceToken(): string {
    const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    return collaborators.exchangeInvitation(code, 'phone').token;
  }

  it('accepts a tailnet-host upgrade authenticated by a collaborator device token (no shared tailscaleToken configured at all)', async () => {
    const token = issueDeviceToken();
    const ws = new WebSocket(
      `ws://127.0.0.1:${collabPort}/ws?token=${encodeURIComponent(token)}`,
      { headers: { host: REMOTE_HOST } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('refuses an upgrade with an unknown or already-revoked device token', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${collabPort}/ws?token=bogus-token`, { headers: { host: REMOTE_HOST } });
    const rejected1 = await new Promise<boolean>((resolve) => {
      ws1.once('error', () => resolve(true));
      ws1.once('open', () => resolve(false));
    });
    ws1.terminate();
    expect(rejected1).toBe(true);

    const { code } = collaborators.inviteCollaborator({ displayName: 'Bob' });
    const { device, token: bobToken } = collaborators.exchangeInvitation(code, 'bob-phone');
    collaborators.revokeDevice(device.id);
    const ws2 = new WebSocket(`ws://127.0.0.1:${collabPort}/ws?token=${encodeURIComponent(bobToken)}`, { headers: { host: REMOTE_HOST } });
    const rejected2 = await new Promise<boolean>((resolve) => {
      ws2.once('error', () => resolve(true));
      ws2.once('open', () => resolve(false));
    });
    ws2.terminate();
    expect(rejected2).toBe(true);
  });

  it('revoking a device terminates its already-open socket without disrupting another device\'s socket (AC5)', async () => {
    const { code: codeA } = collaborators.inviteCollaborator({ displayName: 'Alice' });
    const { device: deviceA, token: tokenA } = collaborators.exchangeInvitation(codeA, 'alice-phone');
    const { code: codeB } = collaborators.inviteCollaborator({ displayName: 'Bob' });
    const { token: tokenB } = collaborators.exchangeInvitation(codeB, 'bob-phone');

    const wsA = new WebSocket(`ws://127.0.0.1:${collabPort}/ws?token=${encodeURIComponent(tokenA)}`, { headers: { host: REMOTE_HOST } });
    const wsB = new WebSocket(`ws://127.0.0.1:${collabPort}/ws?token=${encodeURIComponent(tokenB)}`, { headers: { host: REMOTE_HOST } });
    await Promise.all([wsA, wsB].map((ws) => new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    })));

    const closedA = new Promise<void>((resolve) => wsA.once('close', () => resolve()));
    collaborators.revokeDevice(deviceA.id);
    await closedA;

    expect(wsB.readyState).toBe(WebSocket.OPEN);
    wsB.close();
  });

  it('a collaborator device cannot attach to a session or receive its output over WS (AC4: view only, never guide)', async () => {
    const launched = await collabApp.inject({
      method: 'POST', url: '/api/sessions', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(SPEC),
    });
    const { id, pid } = launched.json() as { id: string; pid: number };

    const token = issueDeviceToken();
    const ws = new WebSocket(`ws://127.0.0.1:${collabPort}/ws?token=${encodeURIComponent(token)}`, { headers: { host: REMOTE_HOST } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const frames: unknown[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    ws.send(JSON.stringify({ t: 'attach', sessionId: id }));
    collabBackend.emitOutput(pid, 'output after a refused attach');
    ws.send(JSON.stringify({ t: 'input', sessionId: id, data: 'echo hi\n' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No replay, no reflow_text — the attach never registered a viewer.
    expect(frames.some((f) => (f as { t: string }).t === 'replay')).toBe(false);
    expect(frames.some((f) => (f as { t: string }).t === 'reflow_text')).toBe(false);
    // The refused attach means 'input' never found a viewing session either.
    expect(collabBackend.written.get(String(pid))).toEqual([]);

    ws.close();
  });
});

describe('ticket 07: run_attention_resolve WS authorization — the same DurableWorkEngine.resolveAttention() REST reaches', () => {
  const REMOTE_HOST = 'attention-test-host.tailnet-1234.ts.net';
  const TOKEN = 'a-real-remote-access-token-0123456789';

  let attnStore: Store;
  let attnManager: SessionManager;
  let attnBackend: FakeBackend;
  let attnSessionsDir: string;
  let attnApp: ReturnType<typeof buildApp>;
  let attnWss: WebSocketServer;
  let attnPort: number;
  let resolveAttention: ReturnType<typeof vi.fn>;

  function setUp(workEngine: unknown) {
    attnStore = new Store(':memory:');
    attnSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-attention-'));
    attnBackend = new FakeBackend();
    attnManager = new SessionManager(attnBackend, attnStore, { sessionsDir: attnSessionsDir });
    attnApp = buildApp({
      config: { ...defaultConfig(), tailscaleToken: TOKEN }, manager: attnManager, store: attnStore, remoteHosts: [REMOTE_HOST],
    });
    return attnApp.listen({ port: 0, host: '127.0.0.1' }).then(() => {
      attnWss = attachWs(
        [attnApp.server], attnManager, '/ws', undefined, undefined,
        { remoteHosts: [REMOTE_HOST], token: TOKEN },
        workEngine as Parameters<typeof attachWs>[6],
      );
      const addr = attnApp.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      attnPort = addr.port;
    });
  }

  beforeEach(() => {
    resolveAttention = vi.fn(async () => ({}));
  });

  afterEach(async () => {
    await closeWs(attnWss);
    await attnApp.close();
    await attnManager.shutdown();
    attnStore.close();
    fs.rmSync(attnSessionsDir, { recursive: true, force: true });
  });

  async function openWs(headers?: Record<string, string>): Promise<WebSocket> {
    const ws = headers
      ? new WebSocket(`ws://127.0.0.1:${attnPort}/ws?token=${encodeURIComponent(TOKEN)}`, { headers })
      : new WebSocket(`ws://127.0.0.1:${attnPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }

  it('a local connection resolving an approval reaches WorkEngine.resolveAttention with the exact decision', async () => {
    await setUp({ resolveAttention });
    const ws = await openWs();

    ws.send(JSON.stringify({ t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'approve' }));
    await vi.waitUntil(() => resolveAttention.mock.calls.length > 0);

    expect(resolveAttention).toHaveBeenCalledWith('run-1', 'attention-1', { kind: 'approve' });
    ws.close();
  });

  it('an authenticated remote connection can also resolve attention — compose is granted to every authenticated remote socket', async () => {
    await setUp({ resolveAttention });
    const ws = await openWs({ host: REMOTE_HOST });

    ws.send(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input', value: 'Use TypeScript',
    }));
    await vi.waitUntil(() => resolveAttention.mock.calls.length > 0);

    expect(resolveAttention).toHaveBeenCalledWith('run-1', 'attention-1', { kind: 'input', value: 'Use TypeScript' });
    ws.close();
  });

  it('relays deny with no stray value field', async () => {
    await setUp({ resolveAttention });
    const ws = await openWs();

    ws.send(JSON.stringify({ t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'deny' }));
    await vi.waitUntil(() => resolveAttention.mock.calls.length > 0);

    expect(resolveAttention).toHaveBeenCalledWith('run-1', 'attention-1', { kind: 'deny' });
    ws.close();
  });

  it('is a silent no-op (never throws or crashes the connection) when no WorkEngine is wired to attachWs', async () => {
    await setUp(undefined);
    const ws = await openWs();

    ws.send(JSON.stringify({ t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'approve' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('ticket 11 AC4: a collaborator device cannot resolve Run attention over WS — that is "guiding" a Run, not viewing it', async () => {
    // Deliberately not using this describe block's shared setUp()/attnWss —
    // attachWs registers its own 'upgrade' listener on the http.Server, so
    // a second attachWs call on the same server (to add a collaborators
    // service) would leave both listeners active and racing. A fully
    // separate app/server/wss, same shape as the "collaborator device
    // WebSocket access" describe block above, avoids that entirely.
    const store = new Store(':memory:');
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-ws-collab-attention-'));
    const manager = new SessionManager(new FakeBackend(), store, { sessionsDir });
    const collaborators = new CollaboratorService(store);
    const app = buildApp({ config: defaultConfig(), manager, store, remoteHosts: [REMOTE_HOST], collaborators });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const wss = attachWs(
      [app.server], manager, '/ws', undefined, undefined,
      { remoteHosts: [REMOTE_HOST] }, { resolveAttention } as unknown as Parameters<typeof attachWs>[6], collaborators,
    );
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    try {
      const { code } = collaborators.inviteCollaborator({ displayName: 'Alice' });
      const { token } = collaborators.exchangeInvitation(code, 'phone');

      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`, { headers: { host: REMOTE_HOST } });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      ws.send(JSON.stringify({ t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'approve' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(resolveAttention).not.toHaveBeenCalled();
      ws.close();
    } finally {
      await closeWs(wss);
      await app.close();
      await manager.shutdown();
      store.close();
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
