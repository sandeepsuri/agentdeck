import crypto from 'node:crypto';
import { APNS_TOKEN, type PushEnvironment } from '../relay/protocol.js';
import type { OwnerDevice, OwnerDeviceAudit, OwnerDeviceRepository, OwnerPushTarget } from '../store/owner-devices.js';

export const PAIRING_TTL_MS = 2 * 60_000;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const bearer = () => crypto.randomBytes(32).toString('base64url');

/** Issue #90: a phone's channel key is exactly 32 bytes, base64url. */
function checkPublicKey(value: string): string {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== value) throw new PairingError('The phone key is not valid.');
  return value;
}

interface Challenge {
  id: string;
  secretHash: string;
  expiresAt: number;
  code?: string;
  label?: string;
  publicKey?: string;
  phoneNonceHash?: string;
  phoneConfirmed: boolean;
  ownerConfirmed: boolean;
  collected?: boolean;
  deviceId?: string;
}

export class PairingError extends Error {}

/** The QR challenge is deliberately transient. A service restart invalidates all unfinished pairings. */
export class OwnerPairingService {
  private readonly challenges = new Map<string, Challenge>();
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(
    private readonly devices: OwnerDeviceRepository,
    private readonly now: () => number = Date.now,
  ) {}

  onRevoke(listener: (id: string) => void): void { this.revokeListeners.add(listener); }

  create(): { id: string; secret: string; expiresAt: string } {
    const id = crypto.randomUUID();
    const secret = bearer();
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.challenges.set(id, { id, secretHash: hash(secret), expiresAt, phoneConfirmed: false, ownerConfirmed: false });
    return { id, secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  private live(id: string): Challenge {
    const challenge = this.challenges.get(id);
    if (!challenge) throw new PairingError('Pairing challenge is unavailable.');
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(id);
      throw new PairingError('Pairing challenge expired.');
    }
    return challenge;
  }

  private phone(id: string, nonce: string): Challenge {
    const challenge = this.live(id);
    if (!challenge.phoneNonceHash || hash(nonce) !== challenge.phoneNonceHash) throw new PairingError('Invalid phone confirmation.');
    return challenge;
  }

  /** `publicKey` (issue #90) is the phone's channel key; over the relay it is the key the handshake proved. */
  join(id: string, secret: string, label: string, publicKey?: string): { nonce: string; code: string; expiresAt: string } {
    const challenge = this.live(id);
    if (challenge.phoneNonceHash || hash(secret) !== challenge.secretHash) throw new PairingError('Pairing challenge already used or mismatched.');
    const cleanLabel = label.trim().slice(0, 80);
    if (!cleanLabel) throw new PairingError('A device name is required.');
    if (publicKey !== undefined) {
      checkPublicKey(publicKey);
      if (this.devices.byPublicKey(publicKey)) throw new PairingError('This phone key is already paired. Revoke the old pairing first.');
      challenge.publicKey = publicKey;
    }
    const nonce = bearer();
    challenge.phoneNonceHash = hash(nonce);
    challenge.code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    challenge.label = cleanLabel;
    return { nonce, code: challenge.code, expiresAt: new Date(challenge.expiresAt).toISOString() };
  }

  status(id: string): { state: 'waiting' | 'compare' | 'confirmed'; code?: string; label?: string; expiresAt: string; ownerConfirmed: boolean; deviceId?: string } {
    const challenge = this.live(id);
    return {
      state: !challenge.code ? 'waiting' : challenge.ownerConfirmed && challenge.phoneConfirmed ? 'confirmed' : 'compare',
      ...(challenge.code ? { code: challenge.code, label: challenge.label } : {}),
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      ownerConfirmed: challenge.ownerConfirmed,
      ...(challenge.deviceId ? { deviceId: challenge.deviceId } : {}),
    };
  }

  confirmOwner(id: string, code: string): void {
    const challenge = this.live(id);
    if (!challenge.code || challenge.code !== code || challenge.ownerConfirmed) throw new PairingError('Pairing code mismatched or already confirmed.');
    challenge.ownerConfirmed = true;
  }

  confirmPhone(id: string, nonce: string, code: string): void {
    const challenge = this.phone(id, nonce);
    if (!challenge.code || challenge.code !== code || challenge.phoneConfirmed) throw new PairingError('Pairing code mismatched or already confirmed.');
    challenge.phoneConfirmed = true;
  }

  collect(id: string, nonce: string): { credential: string; deviceId: string } | undefined {
    const challenge = this.phone(id, nonce);
    if (challenge.collected) throw new PairingError('Pairing credential already collected.');
    if (!challenge.ownerConfirmed || !challenge.phoneConfirmed) return undefined;
    // Another pairing may have claimed the same key since this one joined.
    if (challenge.publicKey && this.devices.byPublicKey(challenge.publicKey)) throw new PairingError('This phone key is already paired. Revoke the old pairing first.');
    const credential = bearer();
    const device: OwnerDevice = {
      id: crypto.randomUUID(), label: challenge.label!, createdAt: new Date(this.now()).toISOString(),
      ...(challenge.publicKey ? { publicKey: challenge.publicKey } : {}),
    };
    this.devices.create(device, hash(credential));
    challenge.collected = true;
    challenge.deviceId = device.id;
    return { credential, deviceId: device.id };
  }

  resolve(credential: string): OwnerDevice | undefined {
    return this.devices.byHash(hash(credential));
  }

  list(): OwnerDevice[] { return this.devices.list(); }

  /** The active paired phone holding this channel key, if any. */
  byPublicKey(publicKey: string): OwnerDevice | undefined { return this.devices.byPublicKey(publicKey); }

  /** Enrolls or rotates an active phone's channel key; only ever called over a direct connection. */
  enrollKey(deviceId: string, publicKey: string): void {
    if (!this.devices.setPublicKey(deviceId, checkPublicKey(publicKey))) throw new PairingError('The key could not be enrolled for this phone.');
  }

  setPushToken(deviceId: string, token: string, environment: PushEnvironment): void {
    if (!APNS_TOKEN.test(token)) throw new PairingError('The notification token is not valid.');
    if (!this.devices.setPushToken(deviceId, token, environment)) throw new PairingError('This phone is no longer paired.');
  }

  pushTargets(): OwnerPushTarget[] { return this.devices.pushTargets(); }

  audit(deviceId: string, action: OwnerDeviceAudit['action'], targetId: string): void {
    this.devices.appendAudit({ id: crypto.randomUUID(), deviceId, action, targetId, createdAt: new Date(this.now()).toISOString() });
  }

  listAudit(deviceId: string): OwnerDeviceAudit[] { return this.devices.listAudit(deviceId); }

  revoke(id: string): boolean {
    const changed = this.devices.revoke(id, new Date(this.now()).toISOString());
    if (changed) for (const listener of this.revokeListeners) listener(id);
    return changed;
  }
}
