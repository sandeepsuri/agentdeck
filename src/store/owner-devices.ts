import type { Database } from 'better-sqlite3';

export interface OwnerDevice {
  id: string;
  label: string;
  createdAt: string;
  revokedAt?: string;
}

export interface OwnerDeviceAudit {
  id: string;
  deviceId: string;
  action: 'session-send' | 'session-input';
  targetId: string;
  createdAt: string;
}

interface Row {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

function project(row: Row): OwnerDevice {
  return {
    id: row.id, label: row.label, createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

export class OwnerDeviceRepository {
  constructor(private readonly db: Database) {}

  create(device: OwnerDevice, credentialHash: string): void {
    this.db.prepare('INSERT INTO owner_devices (id, label, credential_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(device.id, device.label, credentialHash, device.createdAt);
  }

  byHash(hash: string): OwnerDevice | undefined {
    const row = this.db.prepare('SELECT * FROM owner_devices WHERE credential_hash = ?').get(hash) as Row | undefined;
    return row && !row.revoked_at ? project(row) : undefined;
  }

  list(): OwnerDevice[] {
    return (this.db.prepare('SELECT * FROM owner_devices ORDER BY created_at DESC').all() as Row[]).map(project);
  }

  revoke(id: string, at: string): boolean {
    return this.db.prepare('UPDATE owner_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes === 1;
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
