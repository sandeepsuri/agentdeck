// Issue #90: a relay and a stand-in Mac for AgentDeck Phone's relay tests.
// Prints the link the phone needs, then echoes every request it receives.
// The Mac key is the published test-vector key (32 bytes of 1), and only the
// vector's phone key (32 bytes of 2) counts as paired.
//
//   npx tsx scripts/relay-phone-fixture.ts
//   then run the phone tests with TEST_RUNNER_RELAY_FIXTURE='<printed JSON>'
import { randomBytes } from 'node:crypto';
import { exportStaticKey, generateStaticKey } from '../src/relay/channel.js';
import { relayIdentityFrom } from '../src/relay/identity.js';
import { MacRelayLink } from '../src/relay/mac-link.js';
import { startRelay } from '../src/relay/server.js';

const relay = await startRelay({ port: 0, host: '127.0.0.1' });
const identity = relayIdentityFrom(exportStaticKey(generateStaticKey(Buffer.alloc(32, 1))), randomBytes(32).toString('base64url'));
const pairedPhone = generateStaticKey(Buffer.alloc(32, 2)).publicKey;
const link = new MacRelayLink({
  url: relay.url,
  identity,
  lookupPhone: (key) => (key === pairedPhone ? { id: 'phone-1' } : undefined),
  handle: async (request, peer) => (peer.deviceId
    ? { status: 200, body: { method: request.method, path: request.path, token: request.token ?? null, body: request.body ?? null } }
    : { status: 403, body: { error: 'This phone is not paired with this Mac.' } }),
});
link.start();
await new Promise<void>((resolve) => { const check = () => (link.state().state === 'connected' ? resolve() : setTimeout(check, 10)); check(); });
console.log(JSON.stringify({ url: relay.url, mailbox: identity.mailbox, macKey: identity.channel.publicKey }));
process.once('SIGTERM', () => { link.stop(); void relay.close().then(() => process.exit(0)); });
