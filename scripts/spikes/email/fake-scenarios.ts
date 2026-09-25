// Deterministic uncertain-send scenarios against the fake provider. Each one
// states the outcome the protocol must reach and the number of provider-side
// sent copies that may exist afterwards, and every row of the decision
// record's table runs under both provider semantics. Run with:
//
//   npx tsx scripts/spikes/email/run.ts fake
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeProvider, type FakeProviderOptions } from './fake-provider.js';
import { CrashAfterCommit, withSendFault, type SendFault } from './faults.js';
import { IntentJournal, type IntentState } from './journal.js';
import { ownerResolve, reconcileIntent, recordIntent, sendOnce, type ReconcileOptions } from './protocol.js';
import type { DraftRef, EmailSpikeAdapter } from './types.js';

type Semantics = FakeProviderOptions['semantics'];

interface Case {
  name: string;
  provider?: Omit<FakeProviderOptions, 'semantics'>;
  fault?: SendFault;
  /** Remove the draft out-of-band before sending, as an owner deleting it in Gmail would. */
  deleteDraftFirst?: boolean;
  /** Fire two sends for the same intent without awaiting the first. */
  doubleTap?: boolean;
  /** After the first outcome, ask the protocol to send again (a retry button). */
  retry?: boolean;
  expect: Record<Semantics, { state: IntentState; copies: number }>;
  /** Provider dispatches the protocol may make, when that is part of the claim. */
  expectDispatches?: number;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  state: IntentState;
  copies: number;
  dispatches: number;
  evidence?: string;
  detail?: string;
}

const both = (state: IntentState, copies: number) => ({ 'draft-consuming': { state, copies }, 'submit-then-cleanup': { state, copies } });

export const cases: Case[] = [
  { name: 'happy path', expect: both('sent', 1) },
  { name: 'lost response after commit', fault: 'lose-response-after-commit', retry: true, expect: both('sent', 1) },
  {
    name: 'failure before commit, then retry', fault: 'fail-before-commit', retry: true,
    expect: { 'draft-consuming': { state: 'sent', copies: 1 }, 'submit-then-cleanup': { state: 'ambiguous', copies: 0 } },
  },
  {
    // The client times out, the provider commits a moment later. Absence must
    // not be trusted while the request could still be in flight.
    name: 'late commit after client timeout, then retry', provider: { lateCommitAfterChecks: 1 }, retry: true,
    expect: both('sent', 1), expectDispatches: 1,
  },
  { name: 'crash after commit, resumed from journal', fault: 'crash-after-commit', expect: both('sent', 1) },
  { name: 'sent index lags inside the settle window', provider: { sentIndexLag: 2 }, fault: 'lose-response-after-commit', expect: both('sent', 1) },
  { name: 'sent index lags past the settle window, then retry', provider: { sentIndexLag: 10 }, fault: 'lose-response-after-commit', retry: true, expect: both('ambiguous', 1) },
  {
    name: 'provider rewrites Message-ID', provider: { rewritesMessageId: true }, fault: 'lose-response-after-commit',
    expect: { 'draft-consuming': { state: 'sent', copies: 1 }, 'submit-then-cleanup': { state: 'ambiguous', copies: 1 } },
  },
  { name: 'draft deleted by owner before send, then retry', deleteDraftFirst: true, retry: true, expect: both('ambiguous', 0) },
  { name: 'double tap with the send in flight', provider: { sendLatency: true }, doubleTap: true, expect: both('sent', 1) },
];

const SETTLE_MS = 5_000;

/** A virtual clock: settle delays advance time instantly but still yield to the event loop. */
function reconcileOptions(): ReconcileOptions {
  let clock = 0;
  return {
    polls: 4,
    settleMs: SETTLE_MS,
    inFlightGraceMs: SETTLE_MS + 1,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await new Promise((resolve) => setImmediate(resolve)); },
  };
}

export async function runFakeScenarios(): Promise<ScenarioResult[]> {
  return withTempDir(async (dir) => {
    const results: ScenarioResult[] = [];
    for (const testCase of cases) {
      for (const semantics of ['draft-consuming', 'submit-then-cleanup'] as const) {
        results.push(await runCase(testCase, semantics, dir, results.length));
      }
    }
    return results;
  });
}

async function runCase(testCase: Case, semantics: Semantics, dir: string, index: number): Promise<ScenarioResult> {
  const name = `${testCase.name} (${semantics})`;
  const provider = new FakeProvider({ semantics, ...testCase.provider });
  const journalDir = path.join(dir, String(index));
  const journal = IntentJournal.in(journalDir);
  const options = reconcileOptions();
  const intentId = `scenario-${index}`;

  const draft = await lookupAndDraft(provider, intentId);
  if (typeof draft === 'string') return { name, passed: false, state: 'not_sent', copies: 0, dispatches: 0, detail: draft };
  if (testCase.deleteDraftFirst) await provider.deleteDraft(draft);

  recordIntent(journal, provider, draft);
  const faulty = withSendFault(provider, testCase.fault ?? 'none');
  if (testCase.doubleTap) {
    await Promise.all([sendOnce(journal, faulty, intentId, options), sendOnce(journal, faulty, intentId, options)]);
  } else {
    try {
      await sendOnce(journal, faulty, intentId, options);
    } catch (error) {
      if (!(error instanceof CrashAfterCommit)) throw error;
      // A fresh process: new journal handle over the same file, unwrapped adapter.
      await reconcileIntent(IntentJournal.in(journalDir), provider, intentId, options);
    }
  }
  if (testCase.retry) await sendOnce(journal, provider, intentId, options);

  const record = journal.get(intentId)!;
  const copies = await provider.sentCopies(draft);
  const expected = testCase.expect[semantics];
  return {
    name,
    passed: record.state === expected.state && copies === expected.copies
      && (testCase.expectDispatches === undefined || record.dispatches === testCase.expectDispatches),
    state: record.state, copies, dispatches: record.dispatches, evidence: record.evidence,
  };
}

/** Find the message to answer, draft a reply in its thread, edit it, and read it back. Returns an error string on failure. */
async function lookupAndDraft(provider: FakeProvider, intentId: string): Promise<DraftRef | string> {
  const self = await provider.selfAddress();
  const incoming = provider.deliver('friend@example.test', 'Dinner on Friday?', 'Are you free?');
  const [match] = await provider.lookup({ from: 'friend@example.test', subjectContains: 'Dinner' }, 5);
  if (!match || match.providerId !== incoming.id) return 'lookup did not find the seeded message';
  const reply = { to: [self], subject: `Re: ${match.subject}`, body: 'Yes', inReplyTo: match.messageIdHeader, threadId: match.threadId };
  const draft = await provider.createDraft(reply, intentId, `<${intentId}@agentdeck.invalid>`);
  const edited = await provider.updateDraft(draft, { ...reply, body: 'Yes, 7pm works' });
  if ((await provider.readDraft(edited))?.body !== 'Yes, 7pm works') return 'draft edit did not read back exactly';
  return edited;
}

/** The owner override exists and is explicit; exercised here so it is not dead spike code. */
export async function ownerOverrideCheck(): Promise<boolean> {
  return withTempDir(async (dir) => {
    const provider = new FakeProvider({ semantics: 'submit-then-cleanup' });
    const journal = IntentJournal.in(dir);
    const options = reconcileOptions();
    const draft = await provider.createDraft({ to: ['owner@example.test'], subject: 's', body: 'b' }, 'owner-1', '<owner-1@agentdeck.invalid>');
    recordIntent(journal, provider, draft);
    await sendOnce(journal, withSendFault(provider, 'fail-before-commit'), 'owner-1', options);
    if (journal.get('owner-1')?.state !== 'ambiguous') return false;
    ownerResolve(journal, 'owner-1', 'allow_resend');
    const after = await sendOnce(journal, provider, 'owner-1', options);
    return after.state === 'sent' && (await provider.sentCopies(draft)) === 1;
  });
}

/**
 * Control, not a protocol test: what a naive client that retries a failed send
 * blindly would do to each provider after a lost response. It backs the
 * decision record's claim that a draft-consuming send cannot be replayed.
 */
export async function blindRetryControl(): Promise<Record<Semantics, number>> {
  const copies = {} as Record<Semantics, number>;
  for (const semantics of ['draft-consuming', 'submit-then-cleanup'] as const) {
    const provider = new FakeProvider({ semantics });
    const draft = await provider.createDraft({ to: ['owner@example.test'], subject: 's', body: 'b' }, 'blind-1', '<blind-1@agentdeck.invalid>');
    const faulty: EmailSpikeAdapter = withSendFault(provider, 'lose-response-after-commit');
    try {
      await faulty.sendDraft(draft);
    } catch {
      await faulty.sendDraft(draft).catch(() => {}); // the blind retry
    }
    copies[semantics] = await provider.sentCopies(draft);
  }
  return copies;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-email-spike-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
