// Issue #90: the relay's one outbound push, through Apple Push Notification
// service. It carries a fixed pointer ("something on your Mac needs you") and
// nothing else: no task, file, or Mac detail ever reaches the relay unsealed,
// so none can reach Apple. Configured by the relay operator with their APNs
// auth key (.p8); without one, the relay sends no pushes.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import type { PushSender } from './server.js';

export const POINTER_PAYLOAD = {
  aps: { alert: { title: 'AgentDeck', body: 'Something on your Mac needs you.' }, sound: 'default' },
} as const;

const HOSTS = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' } as const;
const TOKEN_LIFETIME_MS = 40 * 60 * 1000;

export type ApnsRequest = (host: string, headers: Record<string, string>, body: string) => Promise<number>;

export interface ApnsOptions {
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The phone app's bundle id. */
  topic: string;
  request?: ApnsRequest;
}

const http2Request: ApnsRequest = (host, headers, body) => new Promise((resolve, reject) => {
  const session = http2.connect(host);
  session.on('error', reject);
  const stream = session.request(headers);
  stream.setTimeout(15_000, () => { stream.close(); reject(new Error('APNs did not answer.')); });
  stream.on('response', (response) => {
    resolve(Number(response[':status']));
    session.close();
  });
  stream.on('error', reject);
  stream.end(body);
});

export function apnsPushSender(options: ApnsOptions): PushSender {
  const key: KeyObject = createPrivateKey(options.keyPem);
  const request = options.request ?? http2Request;
  let cached: { value: string; at: number } | undefined;
  const token = () => {
    if (cached && Date.now() - cached.at < TOKEN_LIFETIME_MS) return cached.value;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: options.keyId })}.${encode({ iss: options.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { value: `${unsigned}.${signature}`, at: Date.now() };
    return cached.value;
  };
  return async (deviceToken, environment) => {
    const status = await request(HOSTS[environment], {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${token()}`,
      'apns-topic': options.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    }, JSON.stringify(POINTER_PAYLOAD));
    if (status !== 200) throw new Error(`APNs refused the push (${status}).`);
  };
}
