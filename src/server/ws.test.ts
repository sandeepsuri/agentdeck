// T4 protocol tests: WS bridge + REST routes against a fake backend.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** Scriptable in-memory backend: no real processes. */
class FakeBackend implements SessionBackend {
  private nextPid = 1000;
  emitters = new Map<string, EventEmitter>();
  written = new Map<string, string[]>();
  resized = new Map<string, { cols: number; rows: number }[]>();
  killed = new Map<string, string[]>();

  async spawn(_spec: LaunchSpec): Promise<Handle> {
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
const clients: Client[] = [];

beforeEach(async () => {
  backend = new FakeBackend();
  store = new Store(':memory:');
  manager = new SessionManager(backend, store);
  app = buildApp({ config: defaultConfig(), manager });
  await app.listen({ port: 0, host: '127.0.0.1' });
  wss = attachWs(app.server, manager);
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

const SPEC = { agent: 'claude', cwd: '/tmp' };

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
  it('POST /api/sessions launches and GET lists it', async () => {
    const created = await launchViaRest();
    expect(created.pid).toBe(1000);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    expect(list.map((s: { id: string }) => s.id)).toContain(created.id);
  });

  it('POST /api/sessions rejects bad specs', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'gpt', cwd: '/tmp' }),
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

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-send-'));
    const base = {
      cwd: repoDir,
      startedAt: '2026-07-17T00:00:00.000Z',
      lastActivityAt: '2026-07-17T00:00:00.000Z',
      status: 'idle',
      statusSource: 'cpu_heuristic',
      terminalApp: 'unknown',
    } as const;
    store.upsertSession({ ...base, id: 'ext-1-1', origin: 'external', agent: 'claude' });
    const queued = await send('ext-1-1', 'hello from the deck');
    expect(((await queued.json()) as { delivered: string }).delivered).toBe('queued');
    expect(fs.readFileSync(path.join(repoDir, '.agents', 'inbox.jsonl'), 'utf8')).toContain('hello from the deck');

    store.upsertSession({ ...base, id: 'ext-2-2', origin: 'external', agent: 'codex' });
    expect((await send('ext-2-2', 'hi')).status).toBe(400);
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
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('rejects cross-origin REST requests and WebSocket upgrades', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);

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

  it('input and resize frames reach the backend', async () => {
    const { id } = await launchViaRest();
    const c = await connect();
    c.send({ t: 'attach', sessionId: id });
    await c.waitFor('replay');
    c.send({ t: 'input', data: 'ls\r' });
    c.send({ t: 'resize', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.written.get('1000')).toEqual(['ls\r']);
    expect(backend.resized.get('1000')).toEqual([{ cols: 120, rows: 40 }]);
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
    expect(c.frames).toHaveLength(0); // no replay, no crash
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
});
