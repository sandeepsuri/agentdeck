// Issue #87: migration 028 widens the owner-phone audit to personal-task
// requests and filing decisions, keeping every row recorded before it.
import DatabaseCtor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { Store } from './index.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../migrations');
let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('migration 028_owner_device_personal_audit', () => {
  it('keeps earlier audit rows and accepts personal-task actions', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-migrate-028-'));
    const file = path.join(dir, 'agentdeck.db');
    const priorOnly = path.join(dir, 'prior');
    fs.mkdirSync(priorOnly);
    for (const name of fs.readdirSync(MIGRATIONS).filter((entry) => entry < '028')) {
      fs.copyFileSync(path.join(MIGRATIONS, name), path.join(priorOnly, name));
    }
    const db = new DatabaseCtor(file);
    migrate(db, priorOnly);
    db.prepare("INSERT INTO owner_devices (id, label, credential_hash, created_at) VALUES ('phone-1', 'Phone', 'hash', '2026-09-27T10:00:00.000Z')").run();
    db.prepare("INSERT INTO owner_device_audit (id, device_id, action, target_id, created_at) VALUES ('a1', 'phone-1', 'session-send', 'session-1', '2026-09-27T10:01:00.000Z')").run();
    expect(() => db.prepare("INSERT INTO owner_device_audit (id, device_id, action, target_id, created_at) VALUES ('a2', 'phone-1', 'filing-approve', 'task-1', '2026-09-27T10:02:00.000Z')").run()).toThrow();
    db.close();

    const store = new Store(file);
    store.ownerDevices.appendAudit({ id: 'a2', deviceId: 'phone-1', action: 'filing-approve', targetId: 'task-1', createdAt: '2026-09-27T10:02:00.000Z' });
    expect(store.ownerDevices.listAudit('phone-1').map((row) => [row.action, row.targetId])).toEqual([['filing-approve', 'task-1'], ['session-send', 'session-1']]);
    expect(() => store.ownerDevices.appendAudit({ id: 'a3', deviceId: 'phone-1', action: 'other' as never, targetId: 'x', createdAt: '2026-09-27T10:03:00.000Z' })).toThrow();
    store.close();
  });
});
