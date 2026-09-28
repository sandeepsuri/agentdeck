// Issue #88: migration 029 is additive, and the draft table itself refuses a
// second unsettled write for one reply.
import DatabaseCtor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersonalActor } from '../personal-tasks/types.js';
import { migrate } from './migrate.js';
import { Store } from './index.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../migrations');
const ACTOR: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };
const CONTENT = { to: ['pat@example.test'], cc: [], subject: 'Re: x', body: 'hi', attachments: [] };
let dir: string;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function seeded(): Store {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-email-store-'));
  const store = new Store(path.join(dir, 'agentdeck.db'));
  const at = '2026-09-28T10:00:00.000Z';
  store.email.insertAccount({ id: 'a1', provider: 'gmail', address: 'owner@gmail.com', scopes: ['s'], createdAt: at, createdBy: ACTOR, state: 'ready' });
  store.email.createTask({
    id: 't1', accountId: 'a1', workspace: 'owner', policyVersion: 'personal-email/1', request: 'find it', submittedAt: at, submittedBy: ACTOR, status: 'queued', updatedAt: at,
  }, { at, kind: 'submitted', message: 'asked' });
  return store;
}

describe('migration 029_personal_email', () => {
  it('adds the email tables to a database migrated up to 028 and leaves existing rows alone', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-migrate-029-'));
    const file = path.join(dir, 'agentdeck.db');
    const prior = path.join(dir, 'prior');
    fs.mkdirSync(prior);
    for (const name of fs.readdirSync(MIGRATIONS).filter((entry) => entry < '029')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(prior, name));
    const db = new DatabaseCtor(file);
    migrate(db, prior);
    db.prepare("INSERT INTO settings (key, value) VALUES ('kept', '1')").run();
    db.close();

    new Store(file).close();
    const reopened = new DatabaseCtor(file);
    const tables = (reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['email_account_grants', 'email_tasks', 'email_task_attempts', 'email_task_activity', 'email_reply_drafts']));
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'kept'").get()).toEqual({ value: '1' });
    expect(migrate(reopened, MIGRATIONS)).toEqual([]);
    reopened.close();
  });
});

describe('EmailTaskRepository drafts', () => {
  it('allows one unsettled write per reply and only on top of the version the editor saw', () => {
    const store = seeded();
    const draft = { origin: 'agentdeck' as const, content: CONTENT, intentId: 'i1', createdAt: '2026-09-28T10:01:00.000Z', createdBy: ACTOR };
    expect(store.email.beginDraftVersion('t1', 0, draft)).toBe(1);
    expect(store.email.beginDraftVersion('t1', 1, { ...draft, intentId: 'i2' })).toBeUndefined();
    expect(store.email.settleDraftVersion('t1', 1, ['writing'], 'saved', '2026-09-28T10:02:00.000Z', { providerDraftId: 'r1', digest: 'd1' })).toBe(true);
    expect(store.email.settleDraftVersion('t1', 1, ['writing'], 'failed', '2026-09-28T10:02:00.000Z', {})).toBe(false);
    expect(store.email.beginDraftVersion('t1', 0, { ...draft, intentId: 'stale' })).toBeUndefined();
    expect(store.email.beginDraftVersion('t1', 1, { ...draft, intentId: 'i2', providerDraftId: 'r1' })).toBe(2);
    expect(store.email.listDrafts('t1').map((entry) => [entry.version, entry.state, entry.providerDraftId])).toEqual([[2, 'writing', 'r1'], [1, 'saved', 'r1']]);
    expect(store.email.listUnsettledDrafts().map((entry) => entry.draft.version)).toEqual([2]);
    store.close();
  });
});
