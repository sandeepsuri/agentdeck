import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store/index.js';
import { OwnerPairingService, PAIRING_TTL_MS } from './service.js';

let store: Store;
afterEach(() => store?.close());

describe('owner phone pairing', () => {
  it('requires both matching confirmations and issues one individually revocable credential', () => {
    store = new Store(':memory:');
    const pairing = new OwnerPairingService(store.ownerDevices);
    const challenge = pairing.create();
    expect(() => pairing.join(challenge.id, 'wrong', 'Phone')).toThrow();
    const phone = pairing.join(challenge.id, challenge.secret, 'My iPhone');
    expect(() => pairing.join(challenge.id, challenge.secret, 'Other phone')).toThrow();
    expect(pairing.collect(challenge.id, phone.nonce)).toBeUndefined();
    expect(() => pairing.confirmPhone(challenge.id, phone.nonce, '000000' === phone.code ? '111111' : '000000')).toThrow();
    pairing.confirmPhone(challenge.id, phone.nonce, phone.code);
    expect(pairing.collect(challenge.id, phone.nonce)).toBeUndefined();
    pairing.confirmOwner(challenge.id, phone.code);
    const issued = pairing.collect(challenge.id, phone.nonce)!;
    expect(pairing.resolve(issued.credential)?.label).toBe('My iPhone');
    expect(() => pairing.collect(challenge.id, phone.nonce)).toThrow();
    expect(() => pairing.confirmOwner(challenge.id, phone.code)).toThrow();
    expect(pairing.revoke(issued.deviceId)).toBe(true);
    expect(pairing.resolve(issued.credential)).toBeUndefined();
  });

  it('rejects an expired challenge at every phone and Mac step', () => {
    store = new Store(':memory:');
    let now = 1_000_000;
    const pairing = new OwnerPairingService(store.ownerDevices, () => now);
    const challenge = pairing.create();
    const phone = pairing.join(challenge.id, challenge.secret, 'Phone');
    now += PAIRING_TTL_MS;
    expect(() => pairing.status(challenge.id)).toThrow(/expired/);
    expect(() => pairing.confirmPhone(challenge.id, phone.nonce, phone.code)).toThrow();
    expect(() => pairing.confirmOwner(challenge.id, phone.code)).toThrow();
    expect(pairing.list()).toEqual([]);
  });

  it('stores only credential hashes and resolves a phone after service recreation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-owner-phone-'));
    store = new Store(path.join(dir, 'agentdeck.db'));
    const first = new OwnerPairingService(store.ownerDevices);
    const challenge = first.create();
    const phone = first.join(challenge.id, challenge.secret, 'Phone');
    first.confirmOwner(challenge.id, phone.code);
    first.confirmPhone(challenge.id, phone.nonce, phone.code);
    const issued = first.collect(challenge.id, phone.nonce)!;
    store.close();
    store = new Store(path.join(dir, 'agentdeck.db'));
    const restarted = new OwnerPairingService(store.ownerDevices);
    expect(restarted.resolve(issued.credential)?.id).toBe(issued.deviceId);
    expect(restarted.list()).toEqual([{ id: issued.deviceId, label: 'Phone', createdAt: expect.any(String) }]);
    expect(() => restarted.join(challenge.id, challenge.secret, 'Replay')).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('owner phone channel keys (issue #90)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64url');
  const OTHER = Buffer.alloc(32, 8).toString('base64url');

  function paired(pairing: OwnerPairingService, publicKey?: string) {
    const challenge = pairing.create();
    const phone = pairing.join(challenge.id, challenge.secret, 'My iPhone', publicKey);
    pairing.confirmPhone(challenge.id, phone.nonce, phone.code);
    pairing.confirmOwner(challenge.id, phone.code);
    return pairing.collect(challenge.id, phone.nonce)!;
  }

  it('binds the phone key given at pairing to the new device, and forgets it on revoke', () => {
    store = new Store(':memory:');
    const pairing = new OwnerPairingService(store.ownerDevices);
    const issued = paired(pairing, KEY);
    expect(pairing.byPublicKey(KEY)?.id).toBe(issued.deviceId);
    expect(() => paired(pairing, 'short')).toThrow();
    pairing.revoke(issued.deviceId);
    expect(pairing.byPublicKey(KEY)).toBeUndefined();
  });

  it('lets a phone paired before keys existed enroll one, rotate it, and register a push token', () => {
    store = new Store(':memory:');
    const pairing = new OwnerPairingService(store.ownerDevices);
    const issued = paired(pairing);
    expect(pairing.byPublicKey(KEY)).toBeUndefined();
    pairing.enrollKey(issued.deviceId, KEY);
    expect(pairing.byPublicKey(KEY)?.id).toBe(issued.deviceId);
    pairing.enrollKey(issued.deviceId, OTHER);
    expect(pairing.byPublicKey(KEY)).toBeUndefined();
    expect(pairing.byPublicKey(OTHER)?.id).toBe(issued.deviceId);

    const second = paired(pairing);
    expect(() => pairing.enrollKey(second.deviceId, OTHER)).toThrow();

    pairing.setPushToken(issued.deviceId, 'ab'.repeat(32), 'sandbox');
    expect(() => pairing.setPushToken(issued.deviceId, 'nope', 'sandbox')).toThrow();
    expect(pairing.pushTargets()).toEqual([{ deviceId: issued.deviceId, token: 'ab'.repeat(32), environment: 'sandbox' }]);
    pairing.revoke(issued.deviceId);
    expect(pairing.pushTargets()).toEqual([]);
  });
});

describe('one key, one phone (issue #90)', () => {
  it('refuses to finish a pairing whose key another pairing claimed first', () => {
    store = new Store(':memory:');
    const pairing = new OwnerPairingService(store.ownerDevices);
    const key = Buffer.alloc(32, 5).toString('base64url');
    const start = () => {
      const challenge = pairing.create();
      const phone = pairing.join(challenge.id, challenge.secret, 'Phone', key);
      pairing.confirmPhone(challenge.id, phone.nonce, phone.code);
      pairing.confirmOwner(challenge.id, phone.code);
      return () => pairing.collect(challenge.id, phone.nonce);
    };
    const first = start();
    const second = start();
    expect(first()?.deviceId).toBeDefined();
    expect(second).toThrowError(/already paired/);
  });
});
