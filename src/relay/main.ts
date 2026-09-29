// Issue #90: `npm run relay` — runs the relay as its own service. Deploy it
// behind TLS (the host's proxy terminates wss://); see relay/README.md.
//
//   PORT / RELAY_PORT   port to listen on (default 8080)
//   RELAY_HOST          interface to bind (default 0.0.0.0, for a container)
//   RELAY_TRUST_PROXY   1 behind a proxy that sets X-Forwarded-For (Fly.io does)
//   APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC
//                       optional: all four turn on pointer pushes
import fs from 'node:fs';
import { apnsPushSender } from './apns.js';
import { startRelay } from './server.js';

const env = process.env;
const apns = env.APNS_KEY_FILE && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
  ? apnsPushSender({ keyPem: fs.readFileSync(env.APNS_KEY_FILE, 'utf8'), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC })
  : undefined;

const relay = await startRelay({
  port: Number(env.RELAY_PORT ?? env.PORT ?? 8080),
  host: env.RELAY_HOST ?? '0.0.0.0',
  trustProxy: env.RELAY_TRUST_PROXY === '1',
  ...(apns ? { push: apns } : {}),
  log: (message) => console.log(`[relay] ${message}`),
});
console.log(`[relay] listening on ${relay.url}${apns ? ' with APNs pointer pushes' : ' (pushes off: no APNs key configured)'}`);
const stop = () => void relay.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
