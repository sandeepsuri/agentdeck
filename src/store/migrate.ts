import type { Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run numbered .sql migrations (e.g. 001_init.sql) that haven't been applied
 * yet, in filename order, each inside a transaction. Idempotent: re-running
 * at every boot is the intended usage.
 */
export function migrate(db: Database, migrationsDir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    });
    tx();
    ran.push(file);
  }
  return ran;
}
