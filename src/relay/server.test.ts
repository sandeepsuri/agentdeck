// Issue #90: the relay forwards opaque frames between one registered Mac and
// its phones. It proves which Mac is which by signature, and nothing else.
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mailboxFor, REGISTER_LABEL } from './protocol.js';
import { startRelay, type RunningRelay } from './server.js';

let relay: RunningRelay;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.length = 0;
  await relay?.close();
});

function open(url: string): WebSocket {
  const socket = new WebSocket(url);
  sockets.push(socket);
  return socket;
}

function next(socket: WebSocket): Promise<Record<string, string>> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, string>)));
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
}

function signingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { raw: raw.toString('base64url'), privateKey };
}

async function registerMac(key = signingKey(), forge = false) {
  const mac = open(`${relay.url}/v1/mac`);
  const challenge = await next(mac);
  const nonce = Buffer.from(challenge.n!, 'base64url');
  const signature = sign(null, Buffer.concat([Buffer.from(REGISTER_LABEL), forge ? Buffer.alloc(nonce.length) : nonce]), key.privateKey);
  mac.send(JSON.stringify({ t: 'register', k: key.raw, s: signature.toString('base64url') }));
  return { mac, key, answer: await Promise.race([next(mac), closed(mac).then((close) => ({ t: 'closed', code: String(close.code) }))]) };
}

describe('relay', () => {
  it('forwards frames between a registered Mac and a phone without reading them', async () => {
    const pushes: string[] = [];
    relay = await startRelay({ port: 0, host: '127.0.0.1', push: async (token) => { pushes.push(token); } });
    const { mac, key, answer } = await registerMac();
    expect(answer).toEqual({ t: 'registered', m: mailboxFor(key.raw) });

    const opened = next(mac);
    const phone = open(`${relay.url}/v1/phone/${mailboxFor(key.raw)}`);
    const { c } = await opened;
    expect(c).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const forwarded = next(mac);
    if (phone.readyState !== WebSocket.OPEN) await new Promise((resolve) => phone.once('open', resolve));
    phone.send('sealed-hello');
    expect(await forwarded).toEqual({ t: 'msg', c, d: 'sealed-hello' });

    const back = new Promise<string>((resolve) => phone.once('message', (data) => resolve(String(data))));
    mac.send(JSON.stringify({ t: 'msg', c, d: 'sealed-welcome' }));
    expect(await back).toBe('sealed-welcome');

    const gone = next(mac);
    phone.close();
    expect(await gone).toEqual({ t: 'gone', c });
  });

  it('tells a phone straight away when its Mac is not connected', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' });
    const phone = open(`${relay.url}/v1/phone/${mailboxFor(signingKey().raw)}`);
    expect(await closed(phone)).toEqual({ code: 4404, reason: 'mac-offline' });
  });

  it('refuses a registration whose signature does not match, and a second connection replaces the first', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' });
    expect((await registerMac(signingKey(), true)).answer).toMatchObject({ t: 'closed', code: '4401' });

    const key = signingKey();
    const first = await registerMac(key);
    const replaced = closed(first.mac);
    await registerMac(key);
    expect(await replaced).toEqual({ code: 4409, reason: 'replaced' });
  });

  it('ends phone connections the Mac drops, and all of them when the Mac goes away', async () => {
    relay = await startRelay({ port: 0, host: '127.0.0.1' });
    const { mac, key } = await registerMac();
    const url = `${relay.url}/v1/phone/${mailboxFor(key.raw)}`;
    const firstOpen = next(mac);
    const one = open(url);
    const { c } = await firstOpen;
    const dropped = closed(one);
    mac.send(JSON.stringify({ t: 'drop', c }));
    expect(await dropped).toEqual({ code: 4403, reason: 'dropped' });

    const secondOpen = next(mac);
    const two = open(url);
    await secondOpen;
    const offline = closed(two);
    mac.close();
    expect(await offline).toEqual({ code: 4404, reason: 'mac-offline' });
  });

  it('sends a pointer push for the Mac at most once per interval per phone', async () => {
    const pushes: Array<{ token: string; environment: string }> = [];
    relay = await startRelay({ port: 0, host: '127.0.0.1', pushIntervalMs: 60_000, push: async (token, environment) => { pushes.push({ token, environment }); } });
    const { mac } = await registerMac();
    const token = 'ab'.repeat(32);
    mac.send(JSON.stringify({ t: 'push', token, env: 'sandbox' }));
    mac.send(JSON.stringify({ t: 'push', token, env: 'sandbox' }));
    mac.send(JSON.stringify({ t: 'push', token: 'not a token', env: 'sandbox' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes).toEqual([{ token, environment: 'sandbox' }]);
  });

  it('limits what any one caller can hold: silent phones, connections per address, and pushes per Mac', async () => {
    const pushes: string[] = [];
    relay = await startRelay({ port: 0, host: '127.0.0.1', firstFrameMs: 50, push: async (token) => { pushes.push(token); } });
    const { mac, key } = await registerMac();
    const url = `${relay.url}/v1/phone/${mailboxFor(key.raw)}`;

    expect(await closed(open(url))).toEqual({ code: 4408, reason: 'idle' });

    const held = [open(url), open(url), open(url), open(url)];
    await Promise.all(held.map((socket) => new Promise((resolve) => socket.once('open', resolve))));
    for (const socket of held) socket.send('hello');
    expect(await closed(open(url))).toEqual({ code: 4429, reason: 'full' });

    for (let n = 0; n < 70; n += 1) mac.send(JSON.stringify({ t: 'push', token: n.toString(16).padStart(64, '0'), env: 'sandbox' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pushes).toHaveLength(60);
  });
});
