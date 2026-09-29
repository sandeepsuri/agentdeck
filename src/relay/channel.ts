// Issue #90: the end-to-end channel a paired phone and the Mac speak through
// the relay. The relay forwards these frames and can read none of them.
//
// Handshake (Noise IK shape; AgentDeck Phone mirrors it in RelayChannel.swift):
//   The phone knows the Mac's static key S_m from pairing. It sends an
//   ephemeral e_p and its own static key S_p, sealed under DH(e_p, S_m), and
//   a proof sealed under DH(e_p, S_m) + DH(s_p, S_m): only the holder of s_p
//   can make it. The Mac answers with an ephemeral e_m and a proof sealed
//   under all four DHs, which only the holder of s_m can make. Session keys
//   come from all four DHs, so a later theft of either static key does not
//   open recorded traffic. Every value is bound to a running transcript hash.
//
// Frames: ChaCha20-Poly1305, one key per direction, and a counter nonce that
// must advance by exactly one, so a replayed, dropped, or reordered frame
// ends the connection.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

export const CHANNEL_PROTOCOL = 'agentdeck-relay/1';
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const ZERO_NONCE = Buffer.alloc(12);

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

/** A long-lived X25519 key: the Mac's, or one paired phone's. */
export interface StaticKey {
  readonly privateKey: KeyObject;
  /** Raw 32-byte public key, base64url. */
  readonly publicKey: string;
}

export interface ChannelSession {
  readonly sendKey: Buffer;
  readonly receiveKey: Buffer;
  sent: bigint;
  received: bigint;
}

export interface PhoneHandshake {
  readonly staticKey: StaticKey;
  readonly macKey: Buffer;
  readonly ephemeral: KeyObject;
  readonly dh1: Buffer;
  readonly dh2: Buffer;
  readonly hash: Buffer;
}

const b64 = (value: Buffer) => value.toString('base64url');
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hkdf = (ikm: Buffer, salt: Buffer, info: string, length = 32) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

function privateFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
}

function publicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new ChannelError('A channel key must be 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}

function rawPublic(key: KeyObject): Buffer {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
}

/** Decodes a base64url public key, refusing anything but 32 bytes. */
export function decodePublicKey(value: string): Buffer {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 32 || b64(raw) !== value) throw new ChannelError('A channel key must be 32 bytes, base64url.');
  return raw;
}

/** A static key from 32 raw private bytes, or a new random one. */
export function generateStaticKey(raw: Buffer = randomBytes(32)): StaticKey {
  const privateKey = privateFromRaw(raw);
  return { privateKey, publicKey: b64(rawPublic(privateKey)) };
}

export function publicKeyOf(key: StaticKey): string {
  return key.publicKey;
}

/** The raw private bytes, for keeping the key in the Keychain. */
export function exportStaticKey(key: StaticKey): string {
  return b64(key.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length));
}

export function importStaticKey(value: string): StaticKey {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 32) throw new ChannelError('A stored channel key must be 32 bytes.');
  return generateStaticKey(raw);
}

function dh(privateKey: KeyObject, publicRaw: Buffer): Buffer {
  return diffieHellman({ privateKey, publicKey: publicFromRaw(publicRaw) });
}

function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 16) throw new ChannelError('The frame is too short.');
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: sealed.length - 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new ChannelError('The frame did not authenticate.');
  }
}

function encodeMessage(fields: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

function decodeMessage(message: string, keys: readonly string[]): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(message, 'base64url').toString('utf8'));
  } catch {
    throw new ChannelError('The handshake message is not readable.');
  }
  const fields = parsed as Record<string, unknown>;
  if (!fields || fields.v !== 1 || keys.some((key) => typeof fields[key] !== 'string')) throw new ChannelError('The handshake message is malformed.');
  return fields as Record<string, string>;
}

function sessionFrom(ikm: Buffer, hash: Buffer, role: 'phone' | 'mac'): ChannelSession {
  const okm = hkdf(ikm, hash, 'session', 64);
  const phoneToMac = okm.subarray(0, 32);
  const macToPhone = okm.subarray(32, 64);
  return role === 'phone'
    ? { sendKey: phoneToMac, receiveKey: macToPhone, sent: 0n, received: 0n }
    : { sendKey: macToPhone, receiveKey: phoneToMac, sent: 0n, received: 0n };
}

/** The phone's first message. `ephemeralRaw` is fixed only by the test vector. */
export function phoneHello(phone: StaticKey, macPublicKey: string, ephemeralRaw?: Buffer): { message: string; state: PhoneHandshake } {
  const macKey = decodePublicKey(macPublicKey);
  const ephemeral = privateFromRaw(ephemeralRaw ?? randomBytes(32));
  const e = rawPublic(ephemeral);
  const h1 = sha256(sha256(Buffer.from(CHANNEL_PROTOCOL), macKey), e);
  const dh1 = dh(ephemeral, macKey);
  const sealedStatic = seal(hkdf(dh1, h1, 'k1'), ZERO_NONCE, decodePublicKey(phone.publicKey), h1);
  const h2 = sha256(h1, sealedStatic);
  const dh2 = dh(phone.privateKey, macKey);
  const proof = seal(hkdf(Buffer.concat([dh1, dh2]), h2, 'k2'), ZERO_NONCE, Buffer.from('hello'), h2);
  const h3 = sha256(h2, proof);
  return {
    message: encodeMessage({ v: 1, e: b64(e), s: b64(sealedStatic), p: b64(proof) }),
    state: { staticKey: phone, macKey, ephemeral, dh1, dh2, hash: h3 },
  };
}

/**
 * The Mac checks the phone's hello and answers. It returns the phone's
 * static key, which the caller looks up among paired phones; the handshake
 * alone grants nothing.
 */
export function macAccept(mac: StaticKey, message: string, ephemeralRaw?: Buffer): { reply: string; session: ChannelSession; phoneKey: string } {
  const fields = decodeMessage(message, ['e', 's', 'p']);
  const macKey = decodePublicKey(mac.publicKey);
  const e = decodePublicKey(fields.e!);
  const sealedStatic = Buffer.from(fields.s!, 'base64url');
  const proof = Buffer.from(fields.p!, 'base64url');
  const h1 = sha256(sha256(Buffer.from(CHANNEL_PROTOCOL), macKey), e);
  const dh1 = dh(mac.privateKey, e);
  const phoneRaw = open(hkdf(dh1, h1, 'k1'), ZERO_NONCE, sealedStatic, h1);
  if (phoneRaw.length !== 32) throw new ChannelError('The phone key is malformed.');
  const h2 = sha256(h1, sealedStatic);
  const dh2 = dh(mac.privateKey, phoneRaw);
  open(hkdf(Buffer.concat([dh1, dh2]), h2, 'k2'), ZERO_NONCE, proof, h2);
  const h3 = sha256(h2, proof);

  const ephemeral = privateFromRaw(ephemeralRaw ?? randomBytes(32));
  const em = rawPublic(ephemeral);
  const h4 = sha256(h3, em);
  const ikm = Buffer.concat([dh1, dh2, dh(ephemeral, e), dh(ephemeral, phoneRaw)]);
  const confirm = seal(hkdf(ikm, h4, 'k3'), ZERO_NONCE, Buffer.from('welcome'), h4);
  const h5 = sha256(h4, confirm);
  return {
    reply: encodeMessage({ v: 1, e: b64(em), p: b64(confirm) }),
    session: sessionFrom(ikm, h5, 'mac'),
    phoneKey: b64(phoneRaw),
  };
}

/** The phone checks that the answer came from the Mac it paired with. */
export function phoneFinish(state: PhoneHandshake, reply: string): ChannelSession {
  const fields = decodeMessage(reply, ['e', 'p']);
  const em = decodePublicKey(fields.e!);
  const confirm = Buffer.from(fields.p!, 'base64url');
  const h4 = sha256(state.hash, em);
  const ikm = Buffer.concat([state.dh1, state.dh2, dh(state.ephemeral, em), dh(state.staticKey.privateKey, em)]);
  open(hkdf(ikm, h4, 'k3'), ZERO_NONCE, confirm, h4);
  return sessionFrom(ikm, sha256(h4, confirm), 'phone');
}

function counterNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

export function sealFrame(session: ChannelSession, plaintext: string): string {
  const sealed = seal(session.sendKey, counterNonce(session.sent), Buffer.from(plaintext, 'utf8'), Buffer.alloc(0));
  session.sent += 1n;
  return b64(sealed);
}

/** Opens the next frame; any failure means the connection must end. */
export function openFrame(session: ChannelSession, frame: string): string {
  const plaintext = open(session.receiveKey, counterNonce(session.received), Buffer.from(frame, 'base64url'), Buffer.alloc(0));
  session.received += 1n;
  return plaintext.toString('utf8');
}
