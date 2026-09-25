// The send-exactly-once protocol under test. The rules:
//
//   1. Persist the intent as `dispatching` before the provider call.
//   2. A send whose outcome is not directly observed is reconciled against the
//      provider, never retried blindly.
//   3. Only provider evidence of absence (`not_sent`) re-opens the intent for
//      another dispatch. Silence after the settle window is `ambiguous`, which
//      only the owner may resolve.
//
// Every path that can reach the provider again goes through `sendOnce`, so a
// double tap, a retry, and a resume after a crash all converge here.
import { CrashAfterCommit } from './faults.js';
import type { IntentJournal, IntentRecord } from './journal.js';
import type { DraftRef, EmailSpikeAdapter } from './types.js';

export interface ReconcileOptions {
  /** How many provider checks to make before settling on `ambiguous`. */
  polls: number;
  /** Delay between checks, to let the provider's sent index catch up. */
  settleMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function recordIntent(journal: IntentJournal, adapter: EmailSpikeAdapter, draft: DraftRef): IntentRecord {
  const existing = journal.get(draft.intentId);
  if (existing) return existing;
  return journal.put({
    intentId: draft.intentId,
    adapter: adapter.name,
    draft,
    state: 'not_sent',
    createdAtMs: Date.now(),
    dispatches: 0,
    history: [],
  }, 'intent recorded');
}

export async function sendOnce(
  journal: IntentJournal,
  adapter: EmailSpikeAdapter,
  intentId: string,
  options: ReconcileOptions,
): Promise<IntentRecord> {
  const record = journal.get(intentId);
  if (!record) throw new Error(`Unknown send intent ${intentId}`);
  if (record.state === 'sent' || record.state === 'ambiguous') return record;
  if (record.state === 'dispatching') return reconcileIntent(journal, adapter, intentId, options);

  // Synchronous write before the first await: a concurrent caller now sees
  // `dispatching` and reconciles instead of dispatching a second time.
  const dispatching = journal.put({ ...record, state: 'dispatching', dispatches: record.dispatches + 1 }, 'dispatch');
  try {
    const { providerMessageId } = await adapter.sendDraft(dispatching.draft);
    return journal.put({ ...dispatching, state: 'sent', providerMessageId, evidence: 'send-response' }, 'provider confirmed');
  } catch (error) {
    // A simulated process death must not get to write anything further: the
    // `dispatching` record is all a real crash would leave behind.
    if (error instanceof CrashAfterCommit) throw error;
    journal.put({ ...dispatching, lastError: errorText(error) }, 'send outcome unobserved');
    return reconcileIntent(journal, adapter, intentId, options);
  }
}

export async function reconcileIntent(
  journal: IntentJournal,
  adapter: EmailSpikeAdapter,
  intentId: string,
  options: ReconcileOptions,
): Promise<IntentRecord> {
  const sleep = options.sleep ?? defaultSleep;
  const record = journal.get(intentId);
  if (!record) throw new Error(`Unknown send intent ${intentId}`);
  if (record.state === 'sent') return record;

  let lastVia = 'no check made';
  for (let poll = 0; poll < options.polls; poll += 1) {
    if (poll > 0) await sleep(options.settleMs);
    let evidence;
    try {
      evidence = await adapter.reconcile(record.draft, record.createdAtMs);
    } catch (error) {
      lastVia = `reconcile error: ${errorText(error)}`;
      continue;
    }
    lastVia = evidence.via;
    if (evidence.state === 'sent') {
      return journal.put(
        { ...record, state: 'sent', providerMessageId: evidence.providerMessageId, evidence: evidence.via },
        `reconciled on poll ${poll + 1}`,
      );
    }
    if (evidence.state === 'not_sent') {
      return journal.put({ ...record, state: 'not_sent', evidence: evidence.via }, `absence proven on poll ${poll + 1}`);
    }
  }
  return journal.put({ ...record, state: 'ambiguous', evidence: lastVia }, `unresolved after ${options.polls} polls`);
}

/** The owner's explicit decision on an ambiguous intent, recorded before any further effect. */
export function ownerResolve(journal: IntentJournal, intentId: string, decision: 'mark_sent' | 'allow_resend'): IntentRecord {
  const record = journal.get(intentId);
  if (!record || record.state !== 'ambiguous') throw new Error(`Intent ${intentId} is not ambiguous`);
  return decision === 'mark_sent'
    ? journal.put({ ...record, state: 'sent', evidence: 'owner confirmed' }, 'owner marked sent')
    : journal.put({ ...record, state: 'not_sent', evidence: 'owner allowed resend' }, 'owner allowed resend');
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
