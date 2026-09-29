import type { Database } from 'better-sqlite3';
import type { PushTarget } from '../relay/protocol.js';

export interface OwnerDevice {
  id: string;
  label: string;
  createdAt: string;
  revokedAt?: string;
  /** Issue #90: the public half of the phone's channel key, base64url; absent until enrolled. */
  publicKey?: string;
}

/** Issue #90: where the relay may send a content-free push for one phone. */
export interface OwnerPushTarget extends PushTarget {
  deviceId: string;
}

export interface OwnerDeviceAudit {
  id: string;
  deviceId: string;
  action: 'session-send' | 'session-input'
    // Issue #87: personal-task requests and decisions made from the phone.
    | 'personal-task-submit' | 'personal-task-retry' | 'filing-approve' | 'filing-retry' | 'filing-undo';
  targetId: string;
  createdAt: string;
}

interface Row {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  public_key: string | null;
}

function project(row: Row): OwnerDevice {
  return {
    id: row.id, label: row.label, createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.public_key ? { publicKey: row.public_key } : {}),
  };
}

export class OwnerDeviceRepository {
  constructor(private readonly db: Database) {}

  create(device: OwnerDevice, credentialHash: string): void {
    this.db.prepare('INSERT INTO owner_devices (id, label, credential_hash, created_at, public_key) VALUES (?, ?, ?, ?, ?)')
      .run(device.id, device.label, credentialHash, device.createdAt, device.publicKey ?? null);
  }

  /** An active device by its channel key. */
  byPublicKey(publicKey: string): OwnerDevice | undefined {
    const row = this.db.prepare('SELECT * FROM owner_devices WHERE public_key = ? AND revoked_at IS NULL').get(publicKey) as Row | undefined;
    return row && project(row);
  }

  /** Sets or replaces an active device's key; false when the device is gone or the key belongs to another device. */
  setPublicKey(id: string, publicKey: string): boolean {
    try {
      return this.db.prepare('UPDATE owner_devices SET public_key = ? WHERE id = ? AND revoked_at IS NULL').run(publicKey, id).changes === 1;
    } catch (error) {
      // Only the one-key-per-phone index is an expected refusal.
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw error;
    }
  }

  setPushToken(id: string, token: string, environment: OwnerPushTarget['environment']): boolean {
    return this.db.prepare('UPDATE owner_devices SET push_token = ?, push_environment = ? WHERE id = ? AND revoked_at IS NULL')
      .run(token, environment, id).changes === 1;
  }

  pushTargets(): OwnerPushTarget[] {
    const rows = this.db.prepare('SELECT id, push_token, push_environment FROM owner_devices WHERE revoked_at IS NULL AND push_token IS NOT NULL ORDER BY created_at').all() as {
      id: string; push_token: string; push_environment: string | null;
    }[];
    return rows.map((row) => ({ deviceId: row.id, token: row.push_token, environment: row.push_environment === 'production' ? 'production' : 'sandbox' }));
  }

  byHash(hash: string): OwnerDevice | undefined {
    const row = this.db.prepare('SELECT * FROM owner_devices WHERE credential_hash = ?').get(hash) as Row | undefined;
    return row && !row.revoked_at ? project(row) : undefined;
  }

  list(): OwnerDevice[] {
    return (this.db.prepare('SELECT * FROM owner_devices ORDER BY created_at DESC').all() as Row[]).map(project);
  }

  /** Revoking also forgets the device's key and push token, so neither outlives its access. */
  revoke(id: string, at: string): boolean {
    return this.db.prepare('UPDATE owner_devices SET revoked_at = ?, public_key = NULL, push_token = NULL WHERE id = ? AND revoked_at IS NULL').run(at, id).changes === 1;
  }

  appendAudit(row: OwnerDeviceAudit): void {
    this.db.prepare('INSERT INTO owner_device_audit (id, device_id, action, target_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.deviceId, row.action, row.targetId, row.createdAt);
  }

  listAudit(deviceId: string): OwnerDeviceAudit[] {
    const rows = this.db.prepare('SELECT * FROM owner_device_audit WHERE device_id = ? ORDER BY created_at DESC LIMIT 100').all(deviceId) as {
      id: string; device_id: string; action: OwnerDeviceAudit['action']; target_id: string; created_at: string;
    }[];
    return rows.map((row) => ({ id: row.id, deviceId: row.device_id, action: row.action, targetId: row.target_id, createdAt: row.created_at }));
  }
}
