// Issue #92: saving a PDF or email request that worked, and running it
// again, end to end through the real personal-task and email services. Each
// run is its own task; a routine never carries an approval from one run to
// the next, and a revoked grant blocks the run with a repair the owner can make.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../store/index.js';
import { scriptedFilingProvider, type BrokerCall } from '../../test-fixtures/filing-agent.js';
import { fakeGmailAccess, FakeMailbox, LEASE_MESSAGE, memoryVault, NEWSLETTER_MESSAGE } from '../../test-fixtures/fake-mailbox.js';
import { buildTextPdf } from '../../test-fixtures/pdf.js';
import { EMAIL_BROKER_MCP_TOOLS } from '../email/email-broker.js';
import { MailboxError } from '../email/gmail.js';
import { EmailTaskService } from '../email/service.js';
import { PersonalTaskService } from '../service.js';
import { isFilingProposal, type PersonalActor, type PersonalTaskView } from '../types.js';
import { RoutineError, RoutineService } from './service.js';

const OWNER: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };

// The scripted agent files each document it is shown by its name.
const PLAN: Record<string, [string, string]> = {
  'power.pdf': ['Power 2026-03.pdf', 'Bills/Power'],
  'gas.pdf': ['Gas 2026-04.pdf', 'Bills/Gas'],
};
const fileEverything = async (call: BrokerCall) => {
  const documents = JSON.parse((await call('list_documents')).text) as { document: string; name: string }[];
  for (const document of documents) {
    await call('read_document', { document: document.document });
    const [newName, destination] = PLAN[document.name] ?? [];
    if (newName !== undefined) await call('propose_filing', { document: document.document, new_name: newName, destination });
  }
};
const findLease = async (call: BrokerCall) => {
  await call('search_messages', { query: 'lease' });
  await call('read_message', { message: 'msg-1' });
  await call('propose_reply', { message: 'msg-1', body: 'Hi Pat, yes, I will sign the renewal by Friday.' });
};

let dir: string;
let home: string;
let folder: string;
let store: Store;
let clock: number;
let vault: ReturnType<typeof memoryVault>;
let mailbox: FakeMailbox;
let personal: PersonalTaskService;
let email: EmailTaskService;
let routines: RoutineService;

function boot(): void {
  const now = () => new Date(clock);
  personal = new PersonalTaskService({
    repository: store.personal, homeDir: home, now, filingProvider: scriptedFilingProvider({ script: fileEverything }),
  });
  email = new EmailTaskService({
    repository: store.email, gmail: fakeGmailAccess(mailbox), vault, now,
    provider: scriptedFilingProvider({ script: findLease, turn: { toolsOffered: EMAIL_BROKER_MCP_TOOLS } }),
  });
  routines = new RoutineService({ repository: store.routines, personal, email, now });
}

async function idle(): Promise<void> {
  await personal.whenIdle();
  await email.whenIdle();
}

const pdf = (name: string, text: string) => fs.writeFileSync(path.join(folder, name), buildTextPdf([text]));

beforeEach(() => {
  clock = Date.parse('2026-09-30T09:00:00.000Z');
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-routines-')));
  home = path.join(dir, 'home');
  folder = path.join(home, 'Documents', 'Inbox');
  fs.mkdirSync(folder, { recursive: true });
  pdf('power.pdf', 'City Power & Light March 2026');
  store = new Store(path.join(dir, 'agentdeck.db'));
  vault = memoryVault();
  mailbox = new FakeMailbox('owner@gmail.com', [LEASE_MESSAGE, NEWSLETTER_MESSAGE]);
  boot();
});

afterEach(async () => {
  await idle();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function workingFiling(): Promise<PersonalTaskView> {
  const grant = personal.createGrant(folder, OWNER);
  const task = personal.submitFilingProposal({ grantId: grant.id, files: ['power.pdf'] }, OWNER);
  await idle();
  return personal.get(task.id)!;
}

function digestOf(task: PersonalTaskView | undefined): string {
  if (!task?.result || !isFilingProposal(task.result)) throw new Error(`no proposal: ${task?.failure}`);
  return task.result.planDigest;
}

describe('a PDF filing routine', () => {
  it('is saved from a proposal that worked and each run starts its own task that needs its own approval', async () => {
    const first = await workingFiling();
    personal.approveFiling(first.id, { planDigest: digestOf(first) }, OWNER);
    await idle();
    expect(fs.existsSync(path.join(folder, 'Bills', 'Power', 'Power 2026-03.pdf'))).toBe(true);

    const routine = routines.save({ name: 'File new bills', source: 'personal', taskId: first.id }, OWNER);
    expect(routine).toMatchObject({ name: 'File new bills', kind: 'pdf-filing-proposal', target: { label: 'Inbox', revoked: false }, runs: [] });
    expect(routine.repair).toBeUndefined();

    // A new bill arrives; the routine files what sits loose in the folder, not what it filed last time.
    pdf('gas.pdf', 'Metro Gas April 2026');
    const run = await routines.run(routine.id, OWNER);
    expect(run.outcome).toBe('started');
    await idle();
    const second = personal.get(run.task!.id)!;
    expect(second.id).not.toBe(first.id);
    expect(second.files).toEqual(['gas.pdf']);
    expect(second.status).toBe('completed');
    // No approval carries over: the new proposal waits for the owner, and the first plan's digest cannot approve it.
    expect(second.filing).toBeUndefined();
    expect(() => personal.approveFiling(second.id, { planDigest: digestOf(first) }, OWNER)).toThrow(expect.objectContaining({ code: 'stale-plan' }));
    expect(fs.existsSync(path.join(folder, 'gas.pdf'))).toBe(true);

    personal.approveFiling(second.id, { planDigest: digestOf(second) }, OWNER);
    await idle();
    expect(fs.existsSync(path.join(folder, 'Bills', 'Gas', 'Gas 2026-04.pdf'))).toBe(true);

    const after = routines.get(routine.id)!;
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ sequence: 1, outcome: 'started', by: { displayName: 'owner', device: 'This Mac' }, task: { source: 'personal', id: second.id, status: 'completed' } });
    // The first task, and its result, are untouched.
    expect(personal.get(first.id)!.filing?.state).toBe('finished');
  });

  it('can only be saved from a request that worked', async () => {
    // Without a confined provider, the proposal fails.
    personal = new PersonalTaskService({ repository: store.personal, homeDir: home, now: () => new Date(clock) });
    routines = new RoutineService({ repository: store.routines, personal, email, now: () => new Date(clock) });
    const grant = personal.createGrant(folder, OWNER);
    const broken = personal.submitFilingProposal({ grantId: grant.id, files: ['power.pdf'] }, OWNER);
    await idle();
    expect(personal.get(broken.id)!.status).toBe('failed');
    expect(() => routines.save({ name: 'x', source: 'personal', taskId: broken.id }, OWNER)).toThrow(expect.objectContaining({ code: 'invalid-state' }));
    expect(() => routines.save({ name: 'x', source: 'personal', taskId: 'nope' }, OWNER)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => routines.save({ name: '  ', source: 'personal', taskId: broken.id }, OWNER)).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });

  it('is blocked by a revoked folder with a repair, and runs again once pointed at a folder chosen again', async () => {
    const first = await workingFiling();
    const routine = routines.save({ name: 'File new bills', source: 'personal', taskId: first.id }, OWNER);
    personal.revokeGrant(first.grant.id);

    expect(routines.get(routine.id)!.repair).toMatchObject({ code: 'folder-revoked' });
    const blocked = await routines.run(routine.id, OWNER);
    expect(blocked).toMatchObject({ outcome: 'blocked', block: { code: 'folder-revoked' } });
    expect(blocked.task).toBeUndefined();
    expect(personal.list()).toHaveLength(1);

    // Pointing it at another revoked grant is refused; at a live one, it runs.
    expect(() => routines.update(routine.id, { grantId: first.grant.id })).toThrow(expect.objectContaining({ code: 'grant-revoked' }));
    const chosenAgain = personal.createGrant(folder, OWNER);
    const repaired = routines.update(routine.id, { grantId: chosenAgain.id });
    expect(repaired.repair).toBeUndefined();
    const run = await routines.run(routine.id, OWNER);
    expect(run.outcome).toBe('started');
    await idle();
    expect(personal.get(run.task!.id)).toMatchObject({ status: 'completed', grant: { id: chosenAgain.id } });

    expect(routines.get(routine.id)!.runs.map((entry) => entry.outcome)).toEqual(['started', 'blocked']);
  });

  it('says when the folder is gone or nothing is waiting, without starting a task', async () => {
    const first = await workingFiling();
    const routine = routines.save({ name: 'File new bills', source: 'personal', taskId: first.id }, OWNER);
    // power.pdf is still loose, so move it into a sub-folder by hand: nothing is left to file.
    fs.mkdirSync(path.join(folder, 'Old'));
    fs.renameSync(path.join(folder, 'power.pdf'), path.join(folder, 'Old', 'power.pdf'));
    expect(await routines.run(routine.id, OWNER)).toMatchObject({ outcome: 'blocked', block: { code: 'nothing-to-run' } });

    fs.rmSync(folder, { recursive: true });
    expect(await routines.run(routine.id, OWNER)).toMatchObject({ outcome: 'blocked', block: { code: 'folder-unavailable' } });
    expect(personal.list()).toHaveLength(1);
  });

  it('runs an inventory over every PDF in the folder', async () => {
    const grant = personal.createGrant(folder, OWNER);
    const inventory = personal.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, OWNER);
    await idle();
    const routine = routines.save({ name: 'Count PDFs', source: 'personal', taskId: inventory.id }, OWNER);
    fs.mkdirSync(path.join(folder, 'Old'));
    pdf('Old/gas.pdf', 'Metro Gas');
    const run = await routines.run(routine.id, OWNER);
    await idle();
    expect(personal.get(run.task!.id)).toMatchObject({ kind: 'pdf-inventory', status: 'completed', files: ['Old/gas.pdf', 'power.pdf'] });
  });

  it('will not start again while its last run is still waiting to start', async () => {
    const first = await workingFiling();
    const routine = routines.save({ name: 'File new bills', source: 'personal', taskId: first.id }, OWNER);
    personal = new PersonalTaskService({ repository: store.personal, homeDir: home, now: () => new Date(clock), autoRun: false });
    routines = new RoutineService({ repository: store.routines, personal, email, now: () => new Date(clock) });
    await routines.run(routine.id, OWNER);
    await expect(routines.run(routine.id, OWNER)).rejects.toMatchObject({ code: 'invalid-state' });
  });
});

describe('an email reply routine', () => {
  async function workingReply() {
    const account = await email.connectAccount(OWNER);
    const task = email.submit({ accountId: account.id, request: 'The email from Pat about the lease renewal. Say I will sign by Friday.' }, OWNER);
    await idle();
    return { account, task: email.get(task.id)! };
  }

  it('runs the same request as a new task, which needs its own confirmation, draft, and send approval', async () => {
    const { task } = await workingReply();
    expect(task.status).toBe('completed');
    const routine = routines.save({ name: 'Answer Pat', source: 'email', taskId: task.id }, OWNER);
    expect(routine).toMatchObject({ kind: 'email-reply', target: { label: 'owner@gmail.com' }, request: task.request });

    const run = await routines.run(routine.id, OWNER);
    expect(run.outcome).toBe('started');
    await idle();
    const again = email.get(run.task!.id)!;
    expect(again).toMatchObject({ status: 'completed', request: task.request });
    expect(again.id).not.toBe(task.id);
    expect(again.confirmed).toBeUndefined();
    expect(again.drafts).toEqual([]);
    expect(again.sends).toEqual([]);
    expect(mailbox.sent).toHaveLength(0);

    // The owner confirms, drafts, and approves this run's exact version; only then is anything sent.
    const drafted = await email.confirm(again.id, { messageId: 'gm-lease' }, OWNER);
    const sent = await email.approveSend(again.id, { version: drafted.drafts[0]!.version, digest: drafted.drafts[0]!.digest }, OWNER);
    expect(sent.sends[0]!.state).toBe('sent');
    expect(mailbox.sent).toHaveLength(1);
  });

  it('rechecks the account on each run: revoked or signed out blocks it, and reconnecting repairs it', async () => {
    const { account, task } = await workingReply();
    const routine = routines.save({ name: 'Answer Pat', source: 'email', taskId: task.id }, OWNER);

    // Signed out at Google since the request last worked.
    mailbox.failure = new MailboxError('signed-out', 'The Gmail sign-in expired.');
    const signedOut = await routines.run(routine.id, OWNER);
    expect(signedOut).toMatchObject({ outcome: 'blocked', block: { code: 'account-needs-repair' } });
    expect(signedOut.block!.message).toMatch(/reconnect|sign/i);
    expect(routines.get(routine.id)!.repair).toMatchObject({ code: 'account-needs-repair' });

    await email.revokeAccount(account.id);
    mailbox.failure = undefined;
    expect(await routines.run(routine.id, OWNER)).toMatchObject({ outcome: 'blocked', block: { code: 'account-revoked' } });
    expect(email.list()).toHaveLength(1);

    const reconnected = await email.connectAccount(OWNER);
    expect(reconnected.id).not.toBe(account.id);
    routines.update(routine.id, { accountId: reconnected.id });
    const run = await routines.run(routine.id, OWNER);
    expect(run.outcome).toBe('started');
    await idle();
    expect(email.get(run.task!.id)).toMatchObject({ status: 'completed', account: { id: reconnected.id } });
  });

  it('cannot be pointed at a folder, nor a PDF routine at an account', async () => {
    const { account, task } = await workingReply();
    const routine = routines.save({ name: 'Answer Pat', source: 'email', taskId: task.id }, OWNER);
    expect(() => routines.update(routine.id, { grantId: 'g' })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    const filing = await workingFiling();
    const pdfRoutine = routines.save({ name: 'File', source: 'personal', taskId: filing.id }, OWNER);
    expect(() => routines.update(pdfRoutine.id, { accountId: account.id })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});

describe('keeping routines', () => {
  it('survives a restart, and deleting one keeps the tasks it started', async () => {
    const first = await workingFiling();
    const routine = routines.save({ name: 'File new bills', source: 'personal', taskId: first.id }, OWNER);
    const run = await routines.run(routine.id, OWNER);
    await idle();

    store.close();
    store = new Store(path.join(dir, 'agentdeck.db'));
    boot();
    expect(routines.list().map((entry) => entry.id)).toEqual([routine.id]);
    expect(routines.get(routine.id)!.runs[0]!.task!.id).toBe(run.task!.id);

    routines.remove(routine.id);
    expect(routines.list()).toEqual([]);
    expect(routines.get(routine.id)).toBeUndefined();
    await expect(routines.run(routine.id, OWNER)).rejects.toBeInstanceOf(RoutineError);
    expect(() => routines.remove(routine.id)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(personal.get(run.task!.id)).toMatchObject({ status: 'completed' });
    expect(personal.get(first.id)).toBeDefined();
  });
});
