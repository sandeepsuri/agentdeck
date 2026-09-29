// Issue #90: the relay's push is a fixed pointer. Nothing from a task, the
// Mac, or the phone's request reaches Apple beyond the device token.
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apnsPushSender, POINTER_PAYLOAD } from './apns.js';

describe('APNs pointer push', () => {
  it('sends only the fixed pointer, signed for the team, to the right Apple host', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sent: Array<{ host: string; headers: Record<string, string>; body: string }> = [];
    const push = apnsPushSender({
      keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'KEY123', teamId: 'TEAM456', topic: 'com.example.AgentDeckPhone',
      request: async (host, headers, body) => { sent.push({ host, headers, body }); return 200; },
    });
    await push('ab'.repeat(32), 'sandbox');
    await push('cd'.repeat(32), 'production');

    expect(sent.map((entry) => [entry.host, entry.headers[':path']])).toEqual([
      ['https://api.sandbox.push.apple.com', `/3/device/${'ab'.repeat(32)}`],
      ['https://api.push.apple.com', `/3/device/${'cd'.repeat(32)}`],
    ]);
    expect(JSON.parse(sent[0]!.body)).toEqual(POINTER_PAYLOAD);
    expect(sent[0]!.headers).toMatchObject({ 'apns-topic': 'com.example.AgentDeckPhone', 'apns-push-type': 'alert' });
    const [header, claims, signature] = sent[0]!.headers.authorization!.replace('bearer ', '').split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ iss: 'TEAM456' });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('reports a refused push as an error the relay logs', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const push = apnsPushSender({
      keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'K', teamId: 'T', topic: 'x', request: async () => 410,
    });
    await expect(push('ab'.repeat(32), 'sandbox')).rejects.toThrow(/410/);
  });
});
