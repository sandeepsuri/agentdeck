// Issue #90: a phone's side of the relay in TypeScript. AgentDeck Phone does
// the same in Swift (RelayChannel.swift); this one drives the end-to-end
// tests and shows the exact wire behaviour the phone must follow.
import WebSocket from 'ws';
import { openFrame, phoneFinish, phoneHello, sealFrame, type ChannelSession, type StaticKey } from './channel.js';
import type { RelayLinkInfo } from './protocol.js';

export class RelayUnavailable extends Error {
  constructor(message = 'Mac unavailable') {
    super(message);
    this.name = 'RelayUnavailable';
  }
}

export type { RelayLinkInfo };

export interface PhoneRelayClient {
  request(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<{ status: number; body: unknown }>;
  close(): void;
}

/**
 * Opens a relay connection and completes the handshake; rejects with
 * RelayUnavailable if the Mac is not there. A request the Mac does not answer
 * within `timeoutMs` ends the connection, so a half-open link reads as
 * unavailable rather than waiting.
 */
export async function connectPhone(link: RelayLinkInfo, phoneKey: StaticKey, timeoutMs = 10_000): Promise<PhoneRelayClient> {
  const socket = new WebSocket(`${link.url.replace(/\/+$/, '')}/v1/phone/${link.mailbox}`);
  const pending = new Map<number, { resolve: (value: { status: number; body: unknown }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let session: ChannelSession | undefined;
  let nextId = 1;
  const failAll = () => {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new RelayUnavailable()); }
    pending.clear();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new RelayUnavailable()); }, timeoutMs);
    const hello = phoneHello(phoneKey, link.macKey);
    socket.once('open', () => socket.send(hello.message));
    socket.once('close', () => { clearTimeout(timer); reject(new RelayUnavailable()); });
    socket.once('error', () => undefined);
    socket.once('message', (data) => {
      clearTimeout(timer);
      try {
        session = phoneFinish(hello.state, String(data));
        resolve();
      } catch {
        socket.close();
        reject(new Error('The Mac on the relay is not the Mac this phone paired with.'));
      }
    });
  });

  socket.on('message', (data) => {
    let reply: { id: number; status: number; body: unknown };
    try {
      reply = JSON.parse(openFrame(session!, String(data))) as typeof reply;
    } catch {
      socket.close();
      return;
    }
    const waiting = pending.get(reply.id);
    pending.delete(reply.id);
    if (waiting) { clearTimeout(waiting.timer); waiting.resolve({ status: reply.status, body: reply.body }); }
  });
  socket.on('close', failAll);

  return {
    request: (method, path, options = {}) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) { reject(new RelayUnavailable()); return; }
      const id = nextId++;
      const timer = setTimeout(() => socket.terminate(), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(sealFrame(session!, JSON.stringify({ id, method, path, ...(options.body === undefined ? {} : { body: options.body }), ...(options.token ? { token: options.token } : {}) })));
    }),
    close: () => socket.close(),
  };
}
