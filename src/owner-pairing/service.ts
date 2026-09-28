import crypto from 'node:crypto';
import type { OwnerDevice, OwnerDeviceAudit, OwnerDeviceRepository } from '../store/owner-devices.js';

export const PAIRING_TTL_MS = 2 * 60_000;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const bearer = () => crypto.randomBytes(32).toString('base64url');

interface Challenge {
  id: string;
  secretHash: string;
  expiresAt: number;
  code?: string;
  label?: string;
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

  join(id: string, secret: string, label: string): { nonce: string; code: string; expiresAt: string } {
    const challenge = this.live(id);
    if (challenge.phoneNonceHash || hash(secret) !== challenge.secretHash) throw new PairingError('Pairing challenge already used or mismatched.');
    const cleanLabel = label.trim().slice(0, 80);
    if (!cleanLabel) throw new PairingError('A device name is required.');
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
    const credential = bearer();
    const device: OwnerDevice = { id: crypto.randomUUID(), label: challenge.label!, createdAt: new Date(this.now()).toISOString() };
    this.devices.create(device, hash(credential));
    challenge.collected = true;
    challenge.deviceId = device.id;
    return { credential, deviceId: device.id };
  }

  resolve(credential: string): OwnerDevice | undefined {
    return this.devices.byHash(hash(credential));
  }

  list(): OwnerDevice[] { return this.devices.list(); }

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
