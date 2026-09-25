// Deterministic uncertain-send scenarios against the fake provider. Each one
// states the outcome the protocol must reach and the number of provider-side
// sent copies that may exist afterwards. Run with:
//
//   npx tsx scripts/spikes/email/run.ts fake
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeProvider, type FakeProviderOptions } from './fake-provider.js';
import { CrashAfterCommit, withSendFault, type SendFault } from './faults.js';
import { IntentJournal, type IntentState } from './journal.js';
import { ownerResolve, reconcileIntent, recordIntent, sendOnce, type ReconcileOptions } from './protocol.js';

interface Scenario {
  name: string;
  provider: FakeProviderOptions;
  fault: SendFault;
  /** Remove the draft out-of-band before sending, as an owner deleting it in Gmail would. */
  deleteDraftFirst?: boolean;
  /** Fire two sends for the same intent without awaiting the first. */
  doubleTap?: boolean;
  /** After the first outcome, ask the protocol to send again (a retry button). */
  retry?: boolean;
  expectState: IntentState;
  expectCopies: number;
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

const gmailLike: FakeProviderOptions = { semantics: 'draft-consuming' };
const smtpLike: FakeProviderOptions = { semantics: 'submit-then-cleanup' };

export const scenarios: Scenario[] = [
  { name: 'happy path', provider: gmailLike, fault: 'none', expectState: 'sent', expectCopies: 1 },
  { name: 'lost response after commit (draft-consuming)', provider: gmailLike, fault: 'lose-response-after-commit', retry: true, expectState: 'sent', expectCopies: 1 },
  { name: 'lost response after commit (submit-then-cleanup)', provider: smtpLike, fault: 'lose-response-after-commit', retry: true, expectState: 'sent', expectCopies: 1 },
  { name: 'failure before commit (draft-consuming) is retried safely', provider: gmailLike, fault: 'fail-before-commit', retry: true, expectState: 'sent', expectCopies: 1 },
  { name: 'failure before commit (submit-then-cleanup) stays ambiguous', provider: smtpLike, fault: 'fail-before-commit', retry: true, expectState: 'ambiguous', expectCopies: 0 },
  { name: 'crash after commit, resumed from journal', provider: gmailLike, fault: 'crash-after-commit', expectState: 'sent', expectCopies: 1 },
  { name: 'sent index lags inside the settle window', provider: { ...gmailLike, sentIndexLag: 2 }, fault: 'lose-response-after-commit', expectState: 'sent', expectCopies: 1 },
  { name: 'sent index lags past the settle window (draft-consuming)', provider: { ...gmailLike, sentIndexLag: 10 }, fault: 'lose-response-after-commit', retry: true, expectState: 'ambiguous', expectCopies: 1 },
  { name: 'sent index lags past the settle window (submit-then-cleanup)', provider: { ...smtpLike, sentIndexLag: 10 }, fault: 'lose-response-after-commit', retry: true, expectState: 'ambiguous', expectCopies: 1 },
  { name: 'provider rewrites Message-ID; intent header still reconciles', provider: { ...gmailLike, rewritesMessageId: true }, fault: 'lose-response-after-commit', expectState: 'sent', expectCopies: 1 },
  { name: 'draft deleted by owner before send', provider: gmailLike, fault: 'none', deleteDraftFirst: true, retry: true, expectState: 'ambiguous', expectCopies: 0 },
  { name: 'double tap', provider: gmailLike, fault: 'none', doubleTap: true, expectState: 'sent', expectCopies: 1 },
];

const reconcile: ReconcileOptions = { polls: 4, settleMs: 0, sleep: async () => {} };

export async function runFakeScenarios(): Promise<ScenarioResult[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-email-spike-'));
  try {
    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) results.push(await runScenario(scenario, dir));
    return results;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runScenario(scenario: Scenario, dir: string): Promise<ScenarioResult> {
  const provider = new FakeProvider(scenario.provider);
  const journalDir = path.join(dir, scenario.name.replace(/\W+/g, '-'));
  const journal = IntentJournal.in(journalDir);
  const self = await provider.selfAddress();

  // Lookup and draft: find the message to answer, draft a reply in its thread, edit it.
  const incoming = provider.deliver('friend@example.test', 'Dinner on Friday?', 'Are you free?');
  const [match] = await provider.lookup({ from: 'friend@example.test', subjectContains: 'Dinner' }, 5);
  if (!match || match.providerId !== incoming.id) return fail(scenario, 'lookup did not find the seeded message');
  const intentId = `intent-${journalDir.length}-${scenarios.indexOf(scenario)}`;
  const draft = await provider.createDraft(
    { to: [self], subject: `Re: ${match.subject}`, body: 'Yes', inReplyTo: match.messageIdHeader, threadId: match.threadId },
    intentId,
    `<${intentId}@agentdeck.invalid>`,
  );
  const edited = await provider.updateDraft(draft, { to: [self], subject: `Re: ${match.subject}`, body: 'Yes, 7pm works', threadId: match.threadId });
  const readBack = await provider.readDraft(edited);
  if (readBack?.body !== 'Yes, 7pm works') return fail(scenario, 'draft edit did not read back exactly');
  if (scenario.deleteDraftFirst) await provider.deleteDraft(edited);

  recordIntent(journal, provider, edited);
  const faulty = withSendFault(provider, scenario.fault);

  if (scenario.doubleTap) {
    await Promise.all([sendOnce(journal, faulty, intentId, reconcile), sendOnce(journal, faulty, intentId, reconcile)]);
  } else {
    try {
      await sendOnce(journal, faulty, intentId, reconcile);
    } catch (error) {
      if (!(error instanceof CrashAfterCommit)) throw error;
      // A fresh process: new journal handle over the same file, unwrapped adapter.
      await reconcileIntent(IntentJournal.in(journalDir), provider, intentId, reconcile);
    }
  }
  if (scenario.retry) await sendOnce(journal, provider, intentId, reconcile);

  const record = journal.get(intentId)!;
  const copies = await provider.sentCopies(edited);
  const passed = record.state === scenario.expectState && copies === scenario.expectCopies;
  return { name: scenario.name, passed, state: record.state, copies, dispatches: record.dispatches, evidence: record.evidence };
}

function fail(scenario: Scenario, detail: string): ScenarioResult {
  return { name: scenario.name, passed: false, state: 'not_sent', copies: 0, dispatches: 0, detail };
}

/** The owner override exists and is explicit; exercised here so it is not dead spike code. */
export async function ownerOverrideCheck(): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-email-spike-owner-'));
  try {
    const provider = new FakeProvider({ semantics: 'submit-then-cleanup' });
    const journal = IntentJournal.in(dir);
    const draft = await provider.createDraft({ to: ['owner@example.test'], subject: 's', body: 'b' }, 'owner-1', '<owner-1@agentdeck.invalid>');
    recordIntent(journal, provider, draft);
    await sendOnce(journal, withSendFault(provider, 'fail-before-commit'), 'owner-1', reconcile);
    if (journal.get('owner-1')?.state !== 'ambiguous') return false;
    ownerResolve(journal, 'owner-1', 'allow_resend');
    const after = await sendOnce(journal, provider, 'owner-1', reconcile);
    return after.state === 'sent' && (await provider.sentCopies(draft)) === 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
