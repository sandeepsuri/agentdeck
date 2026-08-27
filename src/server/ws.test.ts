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
import { defaultConfig } from '../config.js';
import { buildApp, isAllowedOrigin, isLoopbackHostHeader } from './app.js';
import { attachWs, closeWs } from './ws.js';
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
  manager = new SessionManager(backend, store);
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
  wss = attachWs(app.server, manager, '/ws', vscode, () => ({
    sessions: manager.listSessions(),
    attention: [],
    agents: [],
  }));
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterEach(async () => {
  while (clients.length) clients.pop()?.close();
  await closeWs(wss);
  await app.close();
  store.close();
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

  it('stop removes the session and broadcasts session_removed', async () => {
    const c = await connect();
    const { id } = await launchViaRest();
    const stopRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: 'POST' });
    expect(await stopRes.json()).toEqual({ ok: true });
    expect(backend.killed.get('1000')).toEqual(['SIGTERM']);

    const removedFrame = await c.waitFor('session_removed');
    expect(removedFrame.sessionId).toBe(id);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    expect(list).toEqual([]);

    const missing = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: 'POST' });
    expect(missing.status).toBe(404);
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

    a.send({ t: 'detach' });
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
    c.send({ t: 'input', data: 'ls\r' });
    // Terminal size is pinned (Stage 2): a resize frame from a viewer must
    // never reach backend.resize, no matter what the client sends.
    c.send({ t: 'resize', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.written.get('1000')).toEqual(['ls\r']);
    expect(backend.resized.get('1000')).toEqual([]);
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
