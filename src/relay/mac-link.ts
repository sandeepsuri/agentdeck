// Issue #90: the Mac's one outbound connection to the relay. The Mac never
// listens for the relay: it dials out, registers its mailbox by signing the
// relay's challenge, and then answers each phone connection the relay opens.
//
// Each phone connection must complete the channel handshake before anything
// else. The handshake yields the phone's key, which is looked up among
// active paired phones on every request, so revoking a phone ends its relay
// access at its next frame (and dropDevice ends it at once). A key the Mac
// does not know may only pair, through a fresh QR challenge.
import { sign } from 'node:crypto';
import WebSocket from 'ws';
import { ChannelError, macAccept, openFrame, sealFrame, type ChannelSession } from './channel.js';
import type { RelayIdentity } from './identity.js';
import { REGISTER_LABEL, RELAY_CLOSE, type PushTarget, type RelayLinkState } from './protocol.js';

export type { RelayLinkState };

/** One request a phone sends through the channel: the same REST call it makes directly. */
export interface RelayRequest {
  id: number;
  method: string;
  path: string;
  body?: unknown;
  /** The phone's bearer credential, sealed with the rest; checked against the handshake key. */
  token?: string;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

/** Who is on the other end: the handshake-proven key, and the paired phone it belongs to, if any. */
export interface RelayPeer {
  phoneKey: string;
  deviceId?: string;
}

export interface MacRelayLinkOptions {
  /** ws(s):// base URL of the relay. */
  url: string;
  identity: RelayIdentity;
  /** An active paired phone by channel key. */
  lookupPhone: (publicKey: string) => { id: string } | undefined;
  handle: (request: RelayRequest, peer: RelayPeer) => Promise<RelayResponse>;
  onState?: (state: RelayLinkState, detail?: string) => void;
  /** First reconnect delay; doubles to a minute. */
  retryMs?: number;
  /** How long a connection may take to finish the handshake. */
  handshakeMs?: number;
  /** How long a key the Mac has not paired may stay connected: long enough to pair, no longer. */
  unpairedMs?: number;
}

interface PhoneConnection {
  session?: ChannelSession;
  phoneKey?: string;
  /** The paired phone this key belonged to when last checked; kept so a revoke can find it. */
  deviceId?: string;
  /** Drops a connection that has not finished the handshake, or not paired, in time. */
  expiry?: NodeJS.Timeout;
}

const MAX_REQUEST_CHARS = 512 * 1024;

export class MacRelayLink {
  private socket: WebSocket | undefined;
  private readonly connections = new Map<string, PhoneConnection>();
  private current: RelayLinkState = 'connecting';
  private detail: string | undefined;
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;
  private readonly firstDelay: number;
  private delay: number;

  constructor(private readonly options: MacRelayLinkOptions) {
    this.firstDelay = options.retryMs ?? 1_000;
    this.delay = this.firstDelay;
  }

  get url(): string { return this.options.url; }
  get mailbox(): string { return this.options.identity.mailbox; }
  get macKey(): string { return this.options.identity.channel.publicKey; }

  state(): { state: RelayLinkState; detail?: string } {
    return { state: this.current, ...(this.detail ? { detail: this.detail } : {}) };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = undefined;
    this.forgetConnections();
    this.setState('stopped');
  }

  /** Ends every relay connection of a phone, as soon as it is revoked. */
  dropDevice(deviceId: string): void {
    for (const [c, connection] of this.connections) {
      if (connection.deviceId === deviceId) this.drop(c);
    }
  }

  /** Asks the relay to send each phone a content-free "something needs you" push. */
  push(targets: readonly PushTarget[]): void {
    if (this.current !== 'connected') return;
    for (const target of targets) this.send({ t: 'push', token: target.token, env: target.environment });
  }

  private setState(state: RelayLinkState, detail?: string): void {
    this.current = state;
    this.detail = detail;
    this.options.onState?.(state, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    const socket = new WebSocket(`${this.options.url.replace(/\/+$/, '')}/v1/mac`, { maxPayload: 1024 * 1024, handshakeTimeout: 15_000 });
    this.socket = socket;
    socket.on('message', (data) => this.receive(socket, String(data)));
    socket.on('error', () => undefined);
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.forgetConnections();
      if (this.stopped) return;
      if (code === RELAY_CLOSE.replaced[0]) this.setState('refused', 'Another AgentDeck with the same relay keys connected to this relay.');
      else if (code === RELAY_CLOSE.refused[0]) this.setState('refused', 'The relay refused this Mac.');
      else this.setState('unreachable', 'The relay is not answering. Phones away from home cannot reach this Mac until it is back.');
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.retry.unref();
      this.delay = Math.min(this.delay * 2, 60_000);
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private drop(c: string): void {
    clearTimeout(this.connections.get(c)?.expiry);
    this.connections.delete(c);
    this.send({ t: 'drop', c });
  }

  private forgetConnections(): void {
    for (const connection of this.connections.values()) clearTimeout(connection.expiry);
    this.connections.clear();
  }

  private expire(c: string, connection: PhoneConnection, ms: number): void {
    clearTimeout(connection.expiry);
    connection.expiry = setTimeout(() => this.drop(c), ms);
    connection.expiry.unref();
  }

  private receive(socket: WebSocket, text: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    if (message.t === 'challenge' && typeof message.n === 'string') {
      const signature = sign(null, Buffer.concat([Buffer.from(REGISTER_LABEL), Buffer.from(message.n, 'base64url')]), this.options.identity.signingKey);
      socket.send(JSON.stringify({ t: 'register', k: this.options.identity.signingPublic, s: signature.toString('base64url') }));
      return;
    }
    if (message.t === 'registered') {
      this.delay = this.firstDelay;
      this.setState('connected');
      return;
    }
    const c = typeof message.c === 'string' ? message.c : undefined;
    if (!c) return;
    if (message.t === 'open') {
      const connection: PhoneConnection = {};
      this.connections.set(c, connection);
      this.expire(c, connection, this.options.handshakeMs ?? 15_000);
    } else if (message.t === 'gone') {
      clearTimeout(this.connections.get(c)?.expiry);
      this.connections.delete(c);
    }
    else if (message.t === 'msg' && typeof message.d === 'string') void this.frame(c, message.d);
  }

  private async frame(c: string, data: string): Promise<void> {
    const connection = this.connections.get(c);
    if (!connection) return;
    if (!connection.session) {
      try {
        const accepted = macAccept(this.options.identity.channel, data);
        connection.session = accepted.session;
        connection.phoneKey = accepted.phoneKey;
        connection.deviceId = this.options.lookupPhone(accepted.phoneKey)?.id;
        // A paired phone may stay; a key the Mac does not know gets only the time pairing takes.
        if (connection.deviceId) clearTimeout(connection.expiry);
        else this.expire(c, connection, this.options.unpairedMs ?? 3 * 60_000);
        this.send({ t: 'msg', c, d: accepted.reply });
      } catch {
        this.drop(c);
      }
      return;
    }
    let request: RelayRequest;
    try {
      if (data.length > MAX_REQUEST_CHARS) throw new ChannelError('The request is too large.');
      request = JSON.parse(openFrame(connection.session, data)) as RelayRequest;
      if (typeof request.id !== 'number' || typeof request.method !== 'string' || typeof request.path !== 'string') throw new ChannelError('The request is malformed.');
    } catch {
      // A frame that does not open, or opens out of order, ends the connection.
      this.drop(c);
      return;
    }
    // Looked up on every request: a phone revoked mid-connection is refused at its next frame.
    const device = this.options.lookupPhone(connection.phoneKey!);
    if (device && !connection.deviceId) clearTimeout(connection.expiry);
    if (device) connection.deviceId = device.id;
    let response: RelayResponse;
    try {
      response = await this.options.handle(request, { phoneKey: connection.phoneKey!, ...(device ? { deviceId: device.id } : {}) });
    } catch {
      response = { status: 500, body: { error: 'AgentDeck could not answer that request.' } };
    }
    const live = this.connections.get(c);
    if (!live?.session) return;
    this.send({ t: 'msg', c, d: sealFrame(live.session, JSON.stringify({ id: request.id, status: response.status, body: response.body })) });
  }
}
