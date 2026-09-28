import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../store/index.js';
import { scriptedFilingProvider, type BrokerCall } from '../../test-fixtures/filing-agent.js';
import { fakeGmailAccess, FakeMailbox, LEASE_MESSAGE, memoryVault, NEWSLETTER_MESSAGE } from '../../test-fixtures/fake-mailbox.js';
import type { FilingProvider } from '../confined-provider.js';
import type { PersonalActor } from '../types.js';
import { TRUSTED_RUNTIME_PROVIDER_DOMAINS } from '../../work-engine/envelope.js';
import { EMAIL_BROKER_MCP_TOOLS } from './email-broker.js';
import { MailboxError } from './gmail.js';
import { EmailTaskError, EmailTaskService, type GmailAccess } from './service.js';

const OWNER: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };
const PHONE: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'phone-1', label: 'Owner iPhone' } };

let dir: string;
let store: Store;
let mailbox: FakeMailbox;
let access: ReturnType<typeof fakeGmailAccess>;
let vault: ReturnType<typeof memoryVault>;
let clock: number;
let service: EmailTaskService;

const findLease = async (call: BrokerCall) => {
  await call('search_messages', { query: 'lease' });
  await call('read_message', { message: 'msg-1' });
  await call('propose_reply', { message: 'msg-1', body: 'Hi Pat, yes, I will sign the renewal by Friday.' });
};

function boot(provider: FilingProvider = agent(findLease), gmail: GmailAccess = access): EmailTaskService {
  service = new EmailTaskService({ repository: store.email, gmail, vault, provider, now: () => new Date(clock), draftGraceMs: 30_000 });
  service.recover();
  return service;
}

function agent(script: (call: BrokerCall) => Promise<void>) {
  return scriptedFilingProvider({ script: (call) => script(call), turn: { toolsOffered: EMAIL_BROKER_MCP_TOOLS } });
}

async function restart(provider?: FilingProvider): Promise<void> {
  await service.whenIdle();
  store.close();
  store = new Store(path.join(dir, 'agentdeck.db'));
  boot(provider);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-email-service-'));
  store = new Store(path.join(dir, 'agentdeck.db'));
  mailbox = new FakeMailbox('owner@gmail.com', [LEASE_MESSAGE, NEWSLETTER_MESSAGE]);
  access = fakeGmailAccess(mailbox);
  vault = memoryVault();
  clock = Date.parse('2026-09-28T10:00:00.000Z');
  boot();
});

afterEach(async () => {
  await service.whenIdle();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connectedTask(request = 'The email from Pat about the lease renewal. Say I will sign by Friday.') {
  const account = await service.connectAccount(OWNER);
  const task = service.submit({ accountId: account.id, request }, OWNER);
  await service.whenIdle();
  return { account, task: service.get(task.id)! };
}

describe('connecting Gmail', () => {
  it('keeps the token in the vault and only metadata in the store', async () => {
    const account = await service.connectAccount(OWNER);
    expect(account).toMatchObject({ provider: 'gmail', address: 'owner@gmail.com', state: 'ready' });
    expect(vault.items.get(account.id)).toBe('rt-1');
    expect(JSON.stringify(store.email.listAccounts())).not.toContain('rt-1');
  });

  it('reconnecting the same address repairs the existing grant rather than adding one', async () => {
    const account = await service.connectAccount(OWNER);
    store.email.setAccountState(account.id, 'signed-out', 'expired', new Date(clock).toISOString());
    const again = await service.connectAccount(OWNER);
    expect(again.id).toBe(account.id);
    expect(again.state).toBe('ready');
    expect(vault.items.get(account.id)).toBe('rt-2');
    expect(service.listAccounts()).toHaveLength(1);
  });

  it('shows a repair state when there is no Gmail client, and refuses an unsupported account', async () => {
    boot(undefined, fakeGmailAccess(mailbox, { client: false }));
    await expect(service.connectAccount(OWNER)).rejects.toMatchObject({ code: 'no-client' });

    const work = new FakeMailbox('owner@company.example', []);
    const workAccess = fakeGmailAccess(work);
    boot(undefined, workAccess);
    await expect(service.connectAccount(OWNER)).rejects.toMatchObject({ code: 'unsupported' });
    expect(workAccess.revoked).toEqual(['rt-1']);
    expect(vault.items.size).toBe(0);
    expect(service.listAccounts()).toEqual([]);
  });

  it('can only be done at the Mac', async () => {
    await expect(service.connectAccount(PHONE)).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('revoking forgets the token here and at Google and stops the account being searched', async () => {
    const account = await service.connectAccount(OWNER);
    await service.revokeAccount(account.id);
    expect(vault.items.size).toBe(0);
    expect(access.revoked).toEqual(['rt-1']);
    expect(() => service.submit({ accountId: account.id, request: 'x' }, OWNER)).toThrowError(EmailTaskError);
  });
});

describe('finding a message', () => {
  it('asks the confined agent through the broker and shows every candidate for confirmation without writing anything', async () => {
    const { task } = await connectedTask();
    expect(task.status).toBe('completed');
    expect(task.result?.proposedMessageId).toBe('gm-lease');
    expect(task.result?.suggestedBody).toBe('Hi Pat, yes, I will sign the renewal by Friday.');
    expect(task.result?.candidates.map((candidate) => [candidate.id, candidate.from, candidate.subject])).toEqual([
      ['gm-lease', 'Pat Landlord <pat@example.test>', 'Lease renewal'],
      ['gm-news', 'Lease Weekly <news@example.test>', 'This week in leases'],
    ]);
    expect(task.result?.candidates[0]!.excerpt).toContain('sign the renewal by Friday');
    expect(task.drafts).toEqual([]);
    expect(mailbox.writes).toEqual([]);
    expect(task.activity.map((entry) => entry.kind)).toEqual([
      'submitted', 'attempt-started', 'access-checked', 'provider-started', 'mail-searched', 'message-read', 'reply-proposed', 'proposal-ready',
    ]);
    expect(task.policyVersion).toBe('personal-email/1');
  });

  it('gives the confined turn only broker tools and no route to Gmail or its sign-in', async () => {
    const requests: unknown[] = [];
    boot(scriptedFilingProvider({
      script: async (call, request) => { requests.push(request); await findLease(call); },
      turn: { toolsOffered: EMAIL_BROKER_MCP_TOOLS },
    }));
    await connectedTask();
    const request = requests[0] as { allowedTools: string[]; prompt: string };
    expect(request.allowedTools).toEqual(EMAIL_BROKER_MCP_TOOLS);
    expect(JSON.stringify(request)).not.toContain('rt-1');
    expect(JSON.stringify(request)).not.toContain('owner@gmail.com');
    // The sandbox's only egress is the provider proxy; it has no Google domain.
    expect(TRUSTED_RUNTIME_PROVIDER_DOMAINS.claude.some((domain) => /google/.test(domain))).toBe(false);
  });

  it('runs no agent when confinement has not been proven', async () => {
    const provider = scriptedFilingProvider({ access: { mode: 'deterministic-only', reason: 'No live probe is recorded.' }, script: findLease });
    boot(provider);
    const { task } = await connectedTask();
    expect(task.status).toBe('failed');
    expect(task.failure).toMatch(/No live probe/);
    expect(provider.turns).toBe(0);
    expect(mailbox.searches).toEqual([]);
  });

  it('fails with a repair state when the Gmail sign-in has expired', async () => {
    const account = await service.connectAccount(OWNER);
    mailbox.failure = new MailboxError('signed-out', 'The Gmail sign-in expired or was removed in your Google account.');
    const submitted = service.submit({ accountId: account.id, request: 'lease' }, OWNER);
    await service.whenIdle();
    expect(service.get(submitted.id)!.failure).toMatch(/Reconnect Gmail/);
    expect(service.listAccounts()[0]).toMatchObject({ state: 'signed-out', repair: expect.stringMatching(/Reconnect Gmail/) });
  });

  it('discards the session when the account grant is revoked mid-turn', async () => {
    const account = await service.connectAccount(OWNER);
    boot(agent(async (call) => {
      await call('search_messages', { query: 'lease' });
      await service.revokeAccount(account.id);
      await call('read_message', { message: 'msg-1' });
      await call('propose_reply', { message: 'msg-1', body: 'x' });
    }));
    const submitted = service.submit({ accountId: account.id, request: 'lease' }, OWNER);
    await service.whenIdle();
    const task = service.get(submitted.id)!;
    expect(task.status).toBe('failed');
    expect(task.failure).toMatch(/revoked/);
    expect(task.result).toBeUndefined();
  });

  it('discards the session when the provider offers tools beyond the broker', async () => {
    boot(scriptedFilingProvider({ script: findLease, turn: { toolsOffered: [...EMAIL_BROKER_MCP_TOOLS, 'Bash'] } }));
    const { task } = await connectedTask();
    expect(task.status).toBe('failed');
    expect(task.failure).toMatch(/beyond AgentDeck's broker/);
  });

  it('interrupts a running attempt at restart without re-running it, and the owner can retry', async () => {
    const account = await service.connectAccount(OWNER);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    boot(agent(async (call) => { await call('search_messages', { query: 'lease' }); await blocked; }));
    const submitted = service.submit({ accountId: account.id, request: 'lease' }, OWNER);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Simulate the process dying: reopen the database while the turn is stuck.
    const stuck = service;
    const stuckStore = store;
    store = new Store(path.join(dir, 'agentdeck.db'));
    boot();
    expect(service.get(submitted.id)).toMatchObject({ status: 'failed', failure: expect.stringMatching(/stopped/) });
    release();
    await stuck.whenIdle().catch(() => undefined);
    stuckStore.close();

    service.retry(submitted.id);
    await service.whenIdle();
    expect(service.get(submitted.id)).toMatchObject({ status: 'completed' });
    expect(service.get(submitted.id)!.attempts.map((attempt) => attempt.outcome)).toEqual(['interrupted', 'completed']);
  });
});

describe('preparing the reply draft', () => {
  it('confirming writes one Gmail draft to the sender, chosen by AgentDeck rather than the email text', async () => {
    const { task } = await connectedTask();
    const confirmed = await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    expect(confirmed.confirmed?.id).toBe('gm-lease');
    expect(confirmed.drafts).toHaveLength(1);
    expect(confirmed.drafts[0]).toMatchObject({
      version: 1, state: 'saved', origin: 'agentdeck',
      content: { to: ['Pat Landlord <pat@example.test>'], cc: [], subject: 'Re: Lease renewal', body: 'Hi Pat, yes, I will sign the renewal by Friday.', attachments: [] },
    });
    expect(confirmed.drafts[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(confirmed.drafts)).not.toContain('thief@example.test');
    expect([...mailbox.drafts.values()][0]!.reply).toMatchObject({ threadId: 'th-lease', inReplyTo: '<lease@example.test>', references: '<lease@example.test>' });
    expect(mailbox.writes).toEqual(['create']);

    // Confirming again (double tap, second device) changes nothing.
    await service.confirm(task.id, { messageId: 'gm-lease' }, PHONE);
    await expect(service.confirm(task.id, { messageId: 'gm-news' }, OWNER)).rejects.toMatchObject({ code: 'invalid-state' });
    expect(mailbox.writes).toEqual(['create']);
  });

  it('can answer a different candidate, starting from an empty body', async () => {
    const { task } = await connectedTask();
    const confirmed = await service.confirm(task.id, { messageId: 'gm-news' }, OWNER);
    expect(confirmed.drafts[0]!.content).toMatchObject({ to: ['Lease Weekly <news@example.test>'], subject: 'Re: This week in leases', body: '' });
    await expect(service.confirm(task.id, { messageId: 'gm-other' }, OWNER)).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('refuses a message the task never found', async () => {
    const { task } = await connectedTask();
    await expect(service.confirm(task.id, { messageId: 'gm-secret' }, OWNER)).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('each edit updates the same Gmail draft as a new durable version showing exactly what Gmail holds', async () => {
    const { task } = await connectedTask();
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    const edited = await service.saveDraft(task.id, {
      baseVersion: 1, to: ['Pat Landlord <pat@example.test>'], cc: ['partner@example.test'], subject: 'Re: Lease renewal', body: 'Signed copy by Thursday.',
    }, PHONE);
    expect(edited.drafts.map((draft) => [draft.version, draft.state, draft.content.body, draft.createdBy.device])).toEqual([
      [2, 'saved', 'Signed copy by Thursday.', 'Owner iPhone'],
      [1, 'saved', 'Hi Pat, yes, I will sign the renewal by Friday.', 'This Mac'],
    ]);
    expect(edited.drafts[0]!.content.cc).toEqual(['partner@example.test']);
    expect(edited.drafts[0]!.digest).not.toBe(edited.drafts[1]!.digest);
    expect(mailbox.drafts.size).toBe(1);
    expect(mailbox.writes).toEqual(['create', 'update']);

    await expect(service.saveDraft(task.id, { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'x', body: 'y' }, OWNER))
      .rejects.toMatchObject({ code: 'stale-draft' });
    await expect(service.saveDraft(task.id, { baseVersion: 2, to: ['pat@example.test\nBcc: x@example.test'], cc: [], subject: 'x', body: 'y' }, OWNER))
      .rejects.toMatchObject({ code: 'invalid-input' });
    // Saving the same content again writes nothing.
    await service.saveDraft(task.id, { baseVersion: 2, ...edited.drafts[0]!.content }, OWNER);
    expect(mailbox.writes).toEqual(['create', 'update']);
  });

  it('survives a restart with the same task, confirmation, and versions', async () => {
    const { task } = await connectedTask();
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    const before = service.get(task.id)!;
    await restart();
    const after = service.get(task.id)!;
    expect(after).toEqual(before);
    expect(service.listAccounts()[0]!.state).toBe('unchecked');
  });

  it('settles a lost create response from Gmail by intent, never writing a second draft', async () => {
    const { task } = await connectedTask();
    mailbox.fault = 'lose-response-after-commit';
    const confirmed = await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    expect(confirmed.drafts[0]).toMatchObject({ version: 1, state: 'uncertain' });
    // Inside the in-flight grace nothing is judged, and no new write may start.
    expect((await service.checkDraft(task.id)).drafts[0]!.state).toBe('uncertain');
    await expect(service.saveDraft(task.id, { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'Re: x', body: 'b' }, OWNER))
      .rejects.toMatchObject({ code: 'stale-draft' });
    clock += 31_000;
    const settled = await service.checkDraft(task.id);
    expect(settled.drafts[0]).toMatchObject({ version: 1, state: 'saved' });
    expect(mailbox.drafts.size).toBe(1);
    expect(mailbox.writes).toEqual(['create']);
  });

  it('marks a create that never reached Gmail as not written, then a new save creates exactly one draft', async () => {
    const { task } = await connectedTask();
    mailbox.fault = 'fail-before-commit';
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    clock += 31_000;
    const settled = await service.checkDraft(task.id);
    expect(settled.drafts[0]).toMatchObject({ version: 1, state: 'failed', reason: expect.stringMatching(/not written/) });
    const saved = await service.saveDraft(task.id, { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'Yes.' }, OWNER);
    expect(saved.drafts[0]).toMatchObject({ version: 2, state: 'saved' });
    expect(mailbox.drafts.size).toBe(1);
  });

  it('settles a version left writing by a crash at the next start', async () => {
    const { task } = await connectedTask();
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    mailbox.fault = 'lose-response-after-commit';
    await service.saveDraft(task.id, { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'v2' }, OWNER);
    clock += 60_000;
    await restart();
    await service.whenIdle();
    const after = service.get(task.id)!;
    expect(after.drafts[0]).toMatchObject({ version: 2, state: 'saved', content: { body: 'v2' } });
    expect(mailbox.drafts.size).toBe(1);
  });

  it('records a change the owner made in Gmail and will not overwrite attachments added there', async () => {
    const { task } = await connectedTask();
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    const [draftId] = [...mailbox.drafts.keys()];
    mailbox.editInGmail(draftId!, { body: 'Edited in Gmail.' }, [{ name: 'lease.pdf', mimeType: 'application/pdf', size: 1234 }]);
    const checked = await service.checkDraft(task.id);
    expect(checked.drafts[0]).toMatchObject({ version: 2, state: 'saved', origin: 'gmail', content: { body: 'Edited in Gmail.', attachments: [{ name: 'lease.pdf' }] } });
    await expect(service.saveDraft(task.id, { baseVersion: 2, to: ['pat@example.test'], cc: [], subject: 'Re: x', body: 'y' }, OWNER))
      .rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('shows when the draft is gone from Gmail and recreates it only on an explicit save', async () => {
    const { task } = await connectedTask();
    await service.confirm(task.id, { messageId: 'gm-lease' }, OWNER);
    mailbox.drafts.clear();
    const checked = await service.checkDraft(task.id);
    expect(checked.activity.at(-1)).toMatchObject({ kind: 'draft-not-saved', message: expect.stringMatching(/no longer has this draft/) });
    expect(mailbox.drafts.size).toBe(0);
    await service.saveDraft(task.id, { baseVersion: 1, to: ['pat@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'again' }, OWNER);
    expect(mailbox.drafts.size).toBe(1);
  });
});
