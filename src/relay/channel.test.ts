// Issue #90: the end-to-end channel between a paired phone and the Mac. The
// relay carries these frames but holds no key that opens them.
import { describe, expect, it } from 'vitest';
import {
  ChannelError, generateStaticKey, macAccept, openFrame, phoneFinish, phoneHello, publicKeyOf, sealFrame, type StaticKey,
} from './channel.js';

const fixed = (byte: number) => Buffer.alloc(32, byte);
const MAC = generateStaticKey(fixed(1));
const PHONE = generateStaticKey(fixed(2));

function handshake(phone: StaticKey = PHONE, mac: StaticKey = MAC) {
  const hello = phoneHello(phone, publicKeyOf(mac), fixed(3));
  const accepted = macAccept(mac, hello.message, fixed(4));
  const phoneSession = phoneFinish(hello.state, accepted.reply);
  return { hello, accepted, phoneSession, macSession: accepted.session };
}

describe('relay channel', () => {
  it('authenticates both static keys and derives matching directional keys', () => {
    const { accepted, phoneSession, macSession } = handshake();
    expect(accepted.phoneKey).toBe(publicKeyOf(PHONE));
    const request = sealFrame(phoneSession, JSON.stringify({ id: 1, path: '/api/personal/tasks' }));
    expect(openFrame(macSession, request)).toBe('{"id":1,"path":"/api/personal/tasks"}');
    const response = sealFrame(macSession, 'ok');
    expect(openFrame(phoneSession, response)).toBe('ok');
    // Frames are unreadable without the session and do not contain the plaintext.
    expect(Buffer.from(request, 'base64url').toString('utf8')).not.toContain('personal');
  });

  it('matches the published test vector the phone app checks', () => {
    const { hello, accepted, phoneSession } = handshake();
    expect({
      macPublic: publicKeyOf(MAC),
      phonePublic: publicKeyOf(PHONE),
      hello: hello.message,
      welcome: accepted.reply,
      firstPhoneFrame: sealFrame(phoneSession, 'vector'),
    }).toMatchInlineSnapshot(`
      {
        "firstPhoneFrame": "9R-5lzkybPbEPOD-BcRRehmzg5-gyg",
        "hello": "eyJ2IjoxLCJlIjoiWGY3ZE8ydlVmMi1panVGZGxwMWJzT3BUZDAxSWk5cjUzeHh1QVNTejd5SSIsInMiOiJaS2ZTT2F2cHRvYWdpRUlKeklFSmozc0FLTUlwQzhyLVBhLW8weC1fRmZkbmwtNHVxSnJJTnlEMmxlRVE4dFhhIiwicCI6InlaRWxEbzFNRVNWdng3WkNWRm9zeDlyQk9zRVgifQ",
        "macPublic": "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk",
        "phonePublic": "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk",
        "welcome": "eyJ2IjoxLCJlIjoickFHeUlKNkdOVS00VXlON1hlRDAtckU4Zjh2ME02WWNBWk5wWVhfczhRcyIsInAiOiI5UE14QjZ0NWhJdG5ON2g3d2d0MzhUZzZ2aGthYXdFIn0",
      }
    `);
  });

  it('refuses a hello meant for another Mac, and a welcome from anyone but the Mac the phone paired with', () => {
    const other = generateStaticKey(fixed(9));
    const hello = phoneHello(PHONE, publicKeyOf(other), fixed(3));
    expect(() => macAccept(MAC, hello.message, fixed(4))).toThrowError(ChannelError);

    const genuine = phoneHello(PHONE, publicKeyOf(MAC), fixed(3));
    const impostor = macAccept(other, phoneHello(PHONE, publicKeyOf(other), fixed(3)).message, fixed(4));
    expect(() => phoneFinish(genuine.state, impostor.reply)).toThrowError(ChannelError);
  });

  it('rejects a tampered, replayed, or reordered frame', () => {
    const { phoneSession, macSession } = handshake();
    const first = sealFrame(phoneSession, 'one');
    const second = sealFrame(phoneSession, 'two');
    const tampered = Buffer.from(first, 'base64url');
    tampered[0]! ^= 1;
    expect(() => openFrame(macSession, tampered.toString('base64url'))).toThrowError(ChannelError);
    expect(() => openFrame(macSession, second)).toThrowError(ChannelError);

    const fresh = handshake();
    const a = sealFrame(fresh.phoneSession, 'a');
    expect(openFrame(fresh.macSession, a)).toBe('a');
    expect(() => openFrame(fresh.macSession, a)).toThrowError(ChannelError);
  });

  it('gives each connection fresh keys', () => {
    const one = handshake();
    const two = phoneHello(PHONE, publicKeyOf(MAC));
    const accepted = macAccept(MAC, two.message);
    const session = phoneFinish(two.state, accepted.reply);
    expect(sealFrame(session, 'same')).not.toBe(sealFrame(one.phoneSession, 'same'));
  });
});
