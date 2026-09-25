// Issue #78 email adapter spike. See scripts/spikes/email/README.md.
//
//   npx tsx scripts/spikes/email/run.ts fake
//   npx tsx scripts/spikes/email/run.ts gmail-auth
//   npx tsx scripts/spikes/email/run.ts live <gmail-api|imap-smtp> [--fault <fault>] [--polls n] [--settle-ms n]
//   npx tsx scripts/spikes/email/run.ts resume <gmail-api|imap-smtp>
//   npx tsx scripts/spikes/email/run.ts status
//   npx tsx scripts/spikes/email/run.ts cleanup <gmail-api|imap-smtp>
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ownerOverrideCheck, runFakeScenarios } from './fake-scenarios.js';
import { CrashAfterCommit, withSendFault, type SendFault } from './faults.js';
import { authorizeGmail, GmailApiAdapter, GMAIL_SCOPES } from './gmail-api.js';
import { ImapSmtpAdapter, imapSmtpConfigFromEnv } from './imap-smtp.js';
import { IntentJournal } from './journal.js';
import { spikeDir, writePrivateJson } from './local-state.js';
import { reconcileIntent, recordIntent, sendOnce, type ReconcileOptions } from './protocol.js';
import type { DraftContent, DraftRef, EmailSpikeAdapter, MessageSummary } from './types.js';

const SUBJECT_TAG = 'agentdeck-spike';

async function main(): Promise<number> {
  const [command, adapterName] = process.argv.slice(2);
  switch (command) {
    case 'fake': return fake();
    case 'gmail-auth': {
      const { scope, elapsedMs } = await authorizeGmail();
      console.log(`Authorized in ${Math.round(elapsedMs / 1000)}s. Granted scopes: ${scope}`);
      const missing = GMAIL_SCOPES.filter((s) => !scope.split(' ').includes(s));
      if (missing.length) console.log(`Missing requested scopes (owner unticked them?): ${missing.join(', ')}`);
      return 0;
    }
    case 'live': return live(adapter(adapterName));
    case 'resume': return resume(adapter(adapterName));
    case 'status': {
      for (const r of IntentJournal.in(spikeDir()).all()) console.log(`${r.intentId}  ${r.adapter}  ${r.state}  dispatches=${r.dispatches}  evidence=${r.evidence ?? '-'}`);
      return 0;
    }
    case 'cleanup': return cleanup(adapter(adapterName));
    default:
      console.error('Usage: run.ts <fake | gmail-auth | live <adapter> | resume <adapter> | status | cleanup <adapter>>');
      return 2;
  }
}

function adapter(name: string | undefined): EmailSpikeAdapter {
  if (name === 'gmail-api') return new GmailApiAdapter();
  if (name === 'imap-smtp') return new ImapSmtpAdapter(imapSmtpConfigFromEnv());
  throw new Error('Adapter must be gmail-api or imap-smtp.');
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function fake(): Promise<number> {
  const results = await runFakeScenarios();
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name.padEnd(62)} state=${r.state.padEnd(9)} copies=${r.copies} dispatches=${r.dispatches} via=${r.evidence ?? r.detail ?? '-'}`);
  }
  const owner = await ownerOverrideCheck();
  console.log(`${owner ? 'PASS' : 'FAIL'}  owner resolves an ambiguous intent before any resend`);
  const failed = results.filter((r) => !r.passed).length + (owner ? 0 : 1);
  console.log(failed ? `\n${failed} scenario(s) failed` : `\nAll ${results.length + 1} scenarios passed; no scenario produced a duplicate send.`);
  return failed ? 1 : 0;
}

/** Every live send goes only to the authenticated mailbox itself. */
function assertSelfOnly(content: DraftContent, self: string): void {
  const all = [...content.to, ...(content.cc ?? [])];
  if (all.length === 0 || all.some((r) => r.toLowerCase() !== self.toLowerCase())) {
    throw new Error('The spike only sends to the authenticated mailbox itself.');
  }
}

async function live(provider: EmailSpikeAdapter): Promise<number> {
  const fault = flag('fault', 'lose-response-after-commit') as SendFault;
  const reconcile: ReconcileOptions = { polls: Number(flag('polls', '6')), settleMs: Number(flag('settle-ms', '5000')) };
  const dir = spikeDir();
  const journal = IntentJournal.in(dir);
  const runId = randomUUID().slice(0, 8);
  const timings: Record<string, number> = {};
  const observations: Record<string, unknown> = { adapter: provider.name, fault, reconcile: { polls: reconcile.polls, settleMs: reconcile.settleMs } };
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await fn(); } finally { timings[label] = Date.now() - started; }
  };

  try {
    const self = await timed('profile', () => provider.selfAddress());
    const domain = self.split('@')[1] ?? 'agentdeck.invalid';

    // 1. Seed: send one tagged message to self through the protocol (no fault).
    const seedIntent = `${runId}-seed`;
    const seedContent: DraftContent = { to: [self], subject: `[${SUBJECT_TAG} ${runId}] seed`, body: `Seed message for AgentDeck email spike run ${runId}.` };
    assertSelfOnly(seedContent, self);
    const requestedSeedId = `<${seedIntent}.${SUBJECT_TAG}@${domain}>`;
    const seedDraft = await timed('draft.create', () => provider.createDraft(seedContent, seedIntent, requestedSeedId));
    observations.draftKeepsRequestedMessageId = seedDraft.messageIdHeader === requestedSeedId;
    recordIntent(journal, provider, seedDraft);
    const seed = await timed('send.clean', () => sendOnce(journal, provider, seedIntent, reconcile));
    if (seed.state !== 'sent') throw new Error(`Seed send ended ${seed.state}`);

    // 2. Lookup: how long until a just-delivered message is findable, the way the owner would search.
    const lookupStarted = Date.now();
    let match: MessageSummary | undefined;
    while (!match && Date.now() - lookupStarted < 60_000) {
      match = (await provider.lookup({ from: self, subjectContains: `${SUBJECT_TAG} ${runId}` }, 5)).find((m) => m.subject.includes('seed'));
      if (!match) await sleep(2000);
    }
    timings['lookup.indexLag'] = Date.now() - lookupStarted;
    if (!match) throw new Error('Seed message never became searchable within 60s');
    observations.sentKeepsRequestedMessageId = match.messageIdHeader === requestedSeedId;
    const byMessageId = await timed('lookup.byMessageId', () => provider.lookup({ messageIdHeader: match!.messageIdHeader }, 5));
    observations.lookupByMessageIdWorks = byMessageId.some((m) => m.messageIdHeader === match!.messageIdHeader);

    // 3. Draft a threaded reply, edit it, and read back exactly what would be sent.
    const replyIntent = `${runId}-reply`;
    const reply: DraftContent = { to: [self], subject: `Re: ${match.subject}`, body: 'First draft.', inReplyTo: match.messageIdHeader, threadId: match.threadId };
    assertSelfOnly(reply, self);
    let draft: DraftRef = await timed('draft.reply', () => provider.createDraft(reply, replyIntent, `<${replyIntent}.${SUBJECT_TAG}@${domain}>`));
    const edited = { ...reply, body: 'Edited draft — this exact text is what gets sent.' };
    draft = await timed('draft.update', () => provider.updateDraft(draft, edited));
    const readBack = await timed('draft.read', () => provider.readDraft(draft));
    observations.draftReadBackExact = !!readBack && readBack.body === edited.body && readBack.subject === edited.subject
      && readBack.to.map((t) => t.toLowerCase()).join() === self.toLowerCase();
    observations.replyStaysInThread = !match.threadId || draft.threadId === match.threadId;

    // 4. Send with an injected fault, then press "retry" as an impatient owner would.
    recordIntent(journal, provider, draft);
    try {
      await timed('send.faulted+reconcile', () => sendOnce(journal, withSendFault(provider, fault), replyIntent, reconcile));
    } catch (error) {
      if (!(error instanceof CrashAfterCommit)) throw error;
      console.log(`Simulated crash after commit. Intent ${replyIntent} is left 'dispatching'.\nNow run: npx tsx scripts/spikes/email/run.ts resume ${provider.name}`);
      return 75;
    }
    const afterFault = journal.get(replyIntent)!;
    const retried = await timed('send.retry', () => sendOnce(journal, provider, replyIntent, reconcile));
    observations.stateAfterFault = afterFault.state;
    observations.evidenceAfterFault = afterFault.evidence;
    observations.finalState = retried.state;
    observations.dispatches = retried.dispatches;
    observations.draftGoneAfterSend = (await provider.readDraft(draft)) === null;

    // 5. The duplicate check, provider-side, after letting the sent index settle.
    await sleep(reconcile.settleMs);
    const copies = await timed('sentCopies', () => provider.sentCopies(draft, afterFault.createdAtMs));
    observations.sentCopies = copies;
    const passed = copies <= 1 && (retried.state !== 'sent' || copies === 1);

    const file = path.join(dir, `results-${provider.name}-${runId}.json`);
    writePrivateJson(file, { runId, at: new Date().toISOString(), passed, timings, observations });
    console.log(JSON.stringify({ passed, timings, observations }, null, 2));
    console.log(`\nResults: ${file}\nSent spike messages carry "[${SUBJECT_TAG} ${runId}]" in the subject.`);
    return passed ? 0 : 1;
  } finally {
    await provider.close?.();
  }
}

async function resume(provider: EmailSpikeAdapter): Promise<number> {
  const journal = IntentJournal.in(spikeDir());
  const reconcile: ReconcileOptions = { polls: Number(flag('polls', '6')), settleMs: Number(flag('settle-ms', '5000')) };
  try {
    for (const record of journal.all().filter((r) => r.adapter === provider.name && r.state === 'dispatching')) {
      const settled = await reconcileIntent(journal, provider, record.intentId, reconcile);
      const copies = await provider.sentCopies(settled.draft, settled.createdAtMs);
      console.log(`${record.intentId}: ${settled.state} via ${settled.evidence}; provider shows ${copies} sent cop${copies === 1 ? 'y' : 'ies'}`);
    }
    return 0;
  } finally {
    await provider.close?.();
  }
}

async function cleanup(provider: EmailSpikeAdapter): Promise<number> {
  const journal = IntentJournal.in(spikeDir());
  try {
    for (const record of journal.all().filter((r) => r.adapter === provider.name && r.state !== 'sent')) {
      if (await provider.readDraft(record.draft)) {
        await provider.deleteDraft(record.draft);
        console.log(`Deleted leftover draft for ${record.intentId}`);
      }
    }
    console.log(`Sent spike messages are not deleted automatically (the minimum scopes cannot trash mail).`);
    console.log(`Find them with the Gmail search: subject:"${SUBJECT_TAG}"`);
    return 0;
  } finally {
    await provider.close?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
