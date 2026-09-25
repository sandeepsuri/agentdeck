// Durable send-intent journal for the spike. Writes are synchronous and
// atomic (temp file + rename) so a second caller in the same process — a
// double tap — always observes the first caller's `dispatching` record before
// either reaches the provider, and a crashed process leaves a readable record
// for `resume`.
import fs from 'node:fs';
import path from 'node:path';
import type { DraftRef, SendEvidence } from './types.js';

export type IntentState =
  /** Recorded before any provider effect; a crash here is resolved by reconciliation. */
  | 'dispatching'
  | 'sent'
  /** The provider positively showed the send did not happen; a retry is safe. */
  | 'not_sent'
  /** Neither outcome could be proven; only the owner may decide what happens next. */
  | 'ambiguous';

export interface IntentRecord {
  intentId: string;
  adapter: string;
  draft: DraftRef;
  state: IntentState;
  createdAtMs: number;
  dispatches: number;
  providerMessageId?: string;
  evidence?: SendEvidence['via'];
  lastError?: string;
  history: Array<{ atMs: number; state: IntentState; note?: string }>;
}

export class IntentJournal {
  constructor(private readonly file: string) {}

  static in(dir: string): IntentJournal {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new IntentJournal(path.join(dir, 'send-intents.json'));
  }

  get(intentId: string): IntentRecord | undefined {
    return this.readAll()[intentId];
  }

  all(): IntentRecord[] {
    return Object.values(this.readAll());
  }

  put(record: IntentRecord, note?: string): IntentRecord {
    const all = this.readAll();
    const next = { ...record, history: [...record.history, { atMs: Date.now(), state: record.state, note }] };
    all[record.intentId] = next;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }

  private readAll(): Record<string, IntentRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, IntentRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}
