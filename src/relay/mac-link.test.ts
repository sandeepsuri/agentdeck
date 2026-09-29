// Issue #90: the Mac's side of the relay gives a connection only as long as
// it has earned: seconds to finish the handshake, and minutes to pair if the
// key is not a paired phone's.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { exportStaticKey, generateStaticKey } from './channel.js';
import { relayIdentityFrom } from './identity.js';
import { MacRelayLink } from './mac-link.js';
import { connectPhone, RelayUnavailable } from './phone-client.js';
import { startRelay, type RunningRelay } from './server.js';

let relay: RunningRelay;
let link: MacRelayLink;
afterEach(async () => { link?.stop(); await relay?.close(); });

async function boot(paired: string) {
  relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const identity = relayIdentityFrom(exportStaticKey(generateStaticKey()), randomBytes(32).toString('base64url'));
  link = new MacRelayLink({
    url: relay.url, identity, handshakeMs: 100, unpairedMs: 150,
    lookupPhone: (key) => (key === paired ? { id: 'phone-1' } : undefined),
    handle: async () => ({ status: 200, body: {} }),
  });
  link.start();
  while (link.state().state !== 'connected') await new Promise((resolve) => setTimeout(resolve, 5));
  return { url: relay.url, mailbox: identity.mailbox, macKey: identity.channel.publicKey };
}

describe('MacRelayLink', () => {
  it('drops a connection that never finishes the handshake, and an unpaired key once pairing time is up', async () => {
    const phone = generateStaticKey();
    const info = await boot(phone.publicKey);
    const silent = new WebSocket(`${info.url}/v1/phone/${info.mailbox}`);
    await new Promise((resolve) => silent.once('open', resolve));
    silent.send('not a handshake, just holding on');
    expect(await new Promise((resolve) => silent.once('close', (code) => resolve(code)))).toBe(4403);

    const stranger = await connectPhone(info, generateStaticKey());
    expect((await stranger.request('GET', '/api/connection')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(stranger.request('GET', '/api/connection')).rejects.toBeInstanceOf(RelayUnavailable);

    const paired = await connectPhone(info, phone);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await paired.request('GET', '/api/personal/tasks')).status).toBe(200);
    paired.close();
  });
});
