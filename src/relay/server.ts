// Issue #90: the relay. A Mac connects outward to it and registers by signing
// a challenge; a paired phone connects to that Mac's mailbox; the relay then
// forwards each text frame between them unchanged. Every frame is sealed end
// to end (channel.ts), so the relay holds no key that opens task content, and
// it decides nothing about owner authority: the Mac checks every phone.
//
// What the relay sees (see relay/README.md): each Mac's mailbox id (a hash of
// its signing key), when phones connect and for how long, frame sizes and
// timing, IP addresses, and the APNs tokens the Mac asks it to push to.
//
// The relay is open to the internet, so it limits what any one caller can
// hold: registrations per address per minute, phone connections per address
// per Mac, a first frame within seconds, and pushes per Mac per hour.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { APNS_TOKEN, mailboxFor, REGISTER_LABEL, RELAY_CLOSE, type PushEnvironment } from './protocol.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_FRAME = 1024 * 1024;
const MAX_PHONES_PER_MAC = 32;
const MAX_PHONES_PER_ADDRESS = 4;
const MAX_REGISTRATIONS_PER_MINUTE = 10;
const MAX_PUSHES_PER_HOUR = 60;
const REGISTER_TIMEOUT_MS = 10_000;
const FIRST_FRAME_MS = 10_000;
const HEARTBEAT_MS = 30_000;

/** Sends one content-free notification; the relay never passes task data to it. */
export type PushSender = (token: string, environment: PushEnvironment) => Promise<void>;

export interface RelayOptions {
  port: number;
  host: string;
  push?: PushSender;
  /** Minimum time between pushes to one phone. */
  pushIntervalMs?: number;
  /** How long a phone may stay connected without sending its first frame. */
  firstFrameMs?: number;
  log?: (message: string) => void;
  /** Take the caller's address from X-Forwarded-For; only behind a proxy that sets it (Fly.io, a load balancer). */
  trustProxy?: boolean;
}

export interface RunningRelay {
  /** ws:// base URL; deployments put TLS in front and publish wss://. */
  readonly url: string;
  close(): Promise<void>;
}

interface MacLink {
  socket: WebSocket;
  phones: Map<string, { socket: WebSocket; address: string }>;
  pushes: number[];
}

const CONTROL_CLOSE = RELAY_CLOSE;

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? (() => undefined);
  const macs = new Map<string, MacLink>();
  const lastPush = new Map<string, number>();
  const registrations = new Map<string, number[]>();
  const pushInterval = options.pushIntervalMs ?? 30_000;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('AgentDeck relay\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const alive = new WeakSet<WebSocket>();

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      socket.ping();
    }
    const now = Date.now();
    for (const [token, at] of lastPush) if (now - at >= pushInterval) lastPush.delete(token);
    for (const [address, times] of registrations) if (times.every((at) => now - at >= 60_000)) registrations.delete(address);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const shut = (socket: WebSocket, [code, reason]: readonly [number, string]) => socket.close(code, reason);

  function acceptMac(socket: WebSocket, address: string): void {
    const now = Date.now();
    const recent = (registrations.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= MAX_REGISTRATIONS_PER_MINUTE) { shut(socket, CONTROL_CLOSE.full); return; }
    registrations.set(address, [...recent, now]);
    const nonce = randomBytes(32);
    let link: { mailbox: string; mac: MacLink } | undefined;
    const timer = setTimeout(() => { if (!link) shut(socket, CONTROL_CLOSE.refused); }, REGISTER_TIMEOUT_MS);
    socket.send(JSON.stringify({ t: 'challenge', n: nonce.toString('base64url') }));
    socket.on('message', (data: RawData) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(data)) as Record<string, unknown>; } catch { shut(socket, CONTROL_CLOSE.refused); return; }
      if (!link) {
        if (message.t !== 'register' || typeof message.k !== 'string' || typeof message.s !== 'string') { shut(socket, CONTROL_CLOSE.refused); return; }
        const raw = Buffer.from(message.k, 'base64url');
        let valid = false;
        try {
          valid = raw.length === 32 && verify(null, Buffer.concat([Buffer.from(REGISTER_LABEL), nonce]),
            createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }), Buffer.from(message.s, 'base64url'));
        } catch { valid = false; }
        if (!valid) { shut(socket, CONTROL_CLOSE.refused); return; }
        clearTimeout(timer);
        const mailbox = mailboxFor(message.k);
        const previous = macs.get(mailbox);
        const mac: MacLink = { socket, phones: new Map(), pushes: [] };
        macs.set(mailbox, mac);
        link = { mailbox, mac };
        if (previous) shut(previous.socket, CONTROL_CLOSE.replaced);
        socket.send(JSON.stringify({ t: 'registered', m: mailbox }));
        log(`mac registered ${mailbox}`);
        return;
      }
      const conn = typeof message.c === 'string' ? link.mac.phones.get(message.c) : undefined;
      if (message.t === 'msg' && conn && typeof message.d === 'string') conn.socket.send(message.d);
      else if (message.t === 'drop' && conn) shut(conn.socket, CONTROL_CLOSE.dropped);
      else if (message.t === 'push' && typeof message.token === 'string') void sendPush(link.mac, message.token, message.env === 'production' ? 'production' : 'sandbox');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!link || macs.get(link.mailbox) !== link.mac) {
        if (link) for (const phone of link.mac.phones.values()) shut(phone.socket, CONTROL_CLOSE.macOffline);
        return;
      }
      macs.delete(link.mailbox);
      for (const phone of link.mac.phones.values()) shut(phone.socket, CONTROL_CLOSE.macOffline);
    });
  }

  // Any registered Mac can ask for a push to any token, so pushes are capped
  // per Mac as well as per phone: the operator's APNs key is not a free sender.
  async function sendPush(mac: MacLink, token: string, environment: PushEnvironment): Promise<void> {
    if (!options.push || !APNS_TOKEN.test(token)) return;
    const now = Date.now();
    if (now - (lastPush.get(token) ?? -Infinity) < pushInterval) return;
    mac.pushes = mac.pushes.filter((at) => now - at < 3_600_000);
    if (mac.pushes.length >= MAX_PUSHES_PER_HOUR) return;
    mac.pushes.push(now);
    lastPush.set(token, now);
    try { await options.push(token, environment); } catch (error) { log(`push failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function acceptPhone(socket: WebSocket, mailbox: string, address: string): void {
    const mac = macs.get(mailbox);
    if (!mac) { shut(socket, CONTROL_CLOSE.macOffline); return; }
    const fromAddress = [...mac.phones.values()].filter((phone) => phone.address === address).length;
    if (mac.phones.size >= MAX_PHONES_PER_MAC || fromAddress >= MAX_PHONES_PER_ADDRESS) { shut(socket, CONTROL_CLOSE.full); return; }
    const c = randomBytes(12).toString('base64url');
    mac.phones.set(c, { socket, address });
    mac.socket.send(JSON.stringify({ t: 'open', c }));
    // A phone starts the handshake at once; one that sends nothing only holds a slot.
    const firstFrame = setTimeout(() => shut(socket, CONTROL_CLOSE.idle), options.firstFrameMs ?? FIRST_FRAME_MS);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(firstFrame);
      if (isBinary) { shut(socket, CONTROL_CLOSE.dropped); return; }
      mac.socket.send(JSON.stringify({ t: 'msg', c, d: String(data) }));
    });
    socket.on('close', () => {
      clearTimeout(firstFrame);
      if (mac.phones.delete(c) && mac.socket.readyState === mac.socket.OPEN) mac.socket.send(JSON.stringify({ t: 'gone', c }));
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const phone = /^\/v1\/phone\/([A-Za-z0-9_-]{32})$/.exec(path);
    if (path !== '/v1/mac' && !phone) { socket.destroy(); return; }
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : undefined;
    const address = forwarded || req.socket.remoteAddress || 'unknown';
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      if (phone) acceptPhone(ws, phone[1]!, address);
      else acceptMac(ws, address);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `ws://${host}:${address.port}`,
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
