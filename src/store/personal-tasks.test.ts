// Issue #80: migration 023 is additive — it applies on top of an existing
// database without touching earlier tables, and re-running is a no-op.
import DatabaseCtor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { Store } from './index.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../migrations');
let dir: string;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration 023_personal_tasks', () => {
  it('adds the personal-task tables to a database migrated up to 022 and leaves existing rows alone', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-migrate-023-'));
    const file = path.join(dir, 'agentdeck.db');
    const priorOnly = path.join(dir, 'prior');
    fs.mkdirSync(priorOnly);
    for (const name of fs.readdirSync(MIGRATIONS).filter((entry) => entry < '023')) {
      fs.copyFileSync(path.join(MIGRATIONS, name), path.join(priorOnly, name));
    }
    const db = new DatabaseCtor(file);
    migrate(db, priorOnly);
    db.prepare("INSERT INTO settings (key, value) VALUES ('kept', '1')").run();
    db.close();

    const store = new Store(file);
    store.close();
    const reopened = new DatabaseCtor(file);
    const tables = (reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['folder_grants', 'personal_tasks', 'personal_task_attempts', 'personal_task_activity']));
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'kept'").get()).toEqual({ value: '1' });
    expect(migrate(reopened, MIGRATIONS)).toEqual([]);
    reopened.close();
  });
});
