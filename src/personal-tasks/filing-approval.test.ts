// Issue #82: approving a filing proposal and carrying it out, end to end
// through PersonalTaskService: a scripted agent proposes through the real
// broker, then the owner approves and AgentDeck moves the files itself.
import DatabaseCtor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { scriptedFilingProvider, type BrokerCall } from '../test-fixtures/filing-agent.js';
import { buildTextPdf } from '../test-fixtures/pdf.js';
import { PersonalTaskError, PersonalTaskService, FILING_APPROVAL_TTL_MS } from './service.js';
import { isFilingProposal, type FilingProposalResult, type PersonalActor, type PersonalTaskView } from './types.js';

const owner: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };
const POWER = buildTextPdf(['City Power & Light', 'Statement March 2026']);
const WATER = buildTextPdf(['Metro Water', 'Bill April 2026']);
const OLD_WATER = buildTextPdf(['an older, different bill']);

const PLAN: Record<string, [string, string]> = {
  'power.pdf': ['Power 2026-03.pdf', 'Bills/Power'],
  'water.pdf': ['Water 2026-04.pdf', 'Bills'],
};

let base: string;
let home: string;
let folder: string;
let store: Store;
let clock: Date;

const at = (relative: string) => path.join(folder, ...relative.split('/'));

const cooperative = (plan: Record<string, [string, string]>) => async (call: BrokerCall) => {
  const documents = JSON.parse((await call('list_documents')).text) as { document: string; name: string }[];
  for (const document of documents) {
    await call('read_document', { document: document.document });
    const [newName, destination] = plan[document.name] ?? [];
    if (newName !== undefined) await call('propose_filing', { document: document.document, new_name: newName, destination });
  }
};

function makeService(options: { autoRun?: boolean; plan?: Record<string, [string, string]> } = {}): PersonalTaskService {
  return new PersonalTaskService({
    repository: store.personal,
    homeDir: home,
    now: () => clock,
    filingProvider: scriptedFilingProvider({ script: cooperative(options.plan ?? PLAN) }),
    ...(options.autoRun === false ? { autoRun: false } : {}),
  });
}

async function propose(service: PersonalTaskService, files = ['power.pdf', 'water.pdf']): Promise<PersonalTaskView> {
  const grant = service.createGrant(folder, owner);
  const { id } = service.submitFilingProposal({ grantId: grant.id, files }, owner);
  await service.whenIdle();
  return service.get(id)!;
}

function proposal(task: PersonalTaskView): FilingProposalResult {
  if (!task.result || !isFilingProposal(task.result)) throw new Error(`no proposal: ${task.failure}`);
  return task.result;
}

function refusal(action: () => unknown): PersonalTaskError {
  try {
    action();
  } catch (error) {
    if (error instanceof PersonalTaskError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  clock = new Date('2026-09-26T12:00:00.000Z');
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-filing-approve-')));
  home = path.join(base, 'home');
  folder = path.join(home, 'Documents', 'Inbox');
  fs.mkdirSync(path.join(folder, 'Bills'), { recursive: true });
  fs.writeFileSync(at('power.pdf'), POWER);
  fs.writeFileSync(at('water.pdf'), WATER);
  fs.writeFileSync(at('Bills/Water 2026-04.pdf'), OLD_WATER);
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('approving a filing proposal', () => {
  it('moves exactly the approved plan and records a receipt per file', async () => {
    const service = makeService();
    const task = await propose(service);
    const { planDigest } = proposal(task);

    const approved = service.approveFiling(task.id, { planDigest, overwrite: ['water.pdf'] }, owner);
    expect(approved.filing).toMatchObject({ state: 'approved', planDigest, approvedBy: { displayName: 'owner', device: 'This Mac' } });
    await service.whenIdle();

    expect(fs.readFileSync(at('Bills/Power/Power 2026-03.pdf'))).toEqual(POWER);
    expect(fs.readFileSync(at('Bills/Water 2026-04.pdf'))).toEqual(WATER);
    expect(fs.existsSync(at('power.pdf'))).toBe(false);
    expect(fs.existsSync(at('water.pdf'))).toBe(false);

    const done = service.get(task.id)!;
    expect(done.filing).toMatchObject({
      state: 'finished',
      receipts: [
        { sequence: 1, source: 'power.pdf', target: 'Bills/Power/Power 2026-03.pdf', overwrite: false, state: 'moved' },
        { sequence: 2, source: 'water.pdf', target: 'Bills/Water 2026-04.pdf', overwrite: true, state: 'moved', reason: expect.stringMatching(/Replaced/) },
      ],
    });
    expect(done.activity.slice(-4).map((entry) => entry.kind)).toEqual(['filing-approved', 'file-moved', 'file-moved', 'filing-finished']);
    expect(done.activity.at(-1)!.message).toMatch(/Moved 2 of 2/);
    expect(JSON.stringify(done)).not.toContain(base);
    expect(JSON.stringify(done.filing)).not.toContain('Sha256');
  });

  it('leaves a file whose target exists in place unless the owner approved replacing it', async () => {
    const service = makeService();
    const task = await propose(service);
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner);
    await service.whenIdle();
    const done = service.get(task.id)!;
    expect(done.filing!.receipts.map((receipt) => receipt.state)).toEqual(['moved', 'skipped']);
    expect(done.filing!.receipts[1]!.reason).toMatch(/did not approve replacing/);
    expect(fs.readFileSync(at('Bills/Water 2026-04.pdf'))).toEqual(OLD_WATER);
    expect(fs.readFileSync(at('water.pdf'))).toEqual(WATER);
  });

  it('refuses a digest that is not the plan on record, and an overwrite the plan did not warn about', async () => {
    const service = makeService();
    const task = await propose(service);
    const stale = refusal(() => service.approveFiling(task.id, { planDigest: 'f'.repeat(64) }, owner));
    expect(stale.code).toBe('stale-plan');
    const wrong = refusal(() => service.approveFiling(task.id, { planDigest: proposal(task).planDigest, overwrite: ['power.pdf'] }, owner));
    expect(wrong.code).toBe('invalid-input');
    expect(refusal(() => service.approveFiling(task.id, { planDigest: 42 }, owner)).code).toBe('invalid-input');
    expect(service.get(task.id)!.filing).toBeUndefined();
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });

  it('refuses a proposal whose stored plan no longer matches its digest', async () => {
    const file = path.join(base, 'agentdeck.db');
    store.close();
    store = new Store(file);
    const task = await propose(makeService());
    const result = proposal(task);
    store.close();
    // Edit the stored plan behind AgentDeck's back, as a corrupted or tampered database would.
    const db = new DatabaseCtor(file);
    const tampered = { ...result, entries: result.entries.map((entry) => ({ ...entry, destination: 'Elsewhere', target: `Elsewhere/${entry.newName}` })) };
    db.prepare('UPDATE personal_tasks SET result = ? WHERE id = ?').run(JSON.stringify(tampered), task.id);
    db.close();
    store = new Store(file);
    expect(refusal(() => makeService().approveFiling(task.id, { planDigest: result.planDigest }, owner)).code).toBe('stale-plan');
  });

  it('binds a replacement to the content the proposal showed, not whatever is there at approval', async () => {
    const service = makeService();
    const task = await propose(service);
    fs.writeFileSync(at('Bills/Water 2026-04.pdf'), buildTextPdf(['changed between review and approval']));
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest, overwrite: ['water.pdf'] }, owner);
    await service.whenIdle();
    expect(service.get(task.id)!.filing!.receipts[1]).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed since you approved/) });
    expect(fs.existsSync(at('water.pdf'))).toBe(true);
  });

  it('files only the first of two plan entries headed for the same name', async () => {
    fs.writeFileSync(at('gas.pdf'), buildTextPdf(['Gas bill']));
    const service = makeService({ plan: { 'power.pdf': ['Utility.pdf', 'Bills'], 'gas.pdf': ['Utility.pdf', 'Bills'] } });
    const task = await propose(service, ['power.pdf', 'gas.pdf']);
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner);
    await service.whenIdle();
    const receipts = service.get(task.id)!.filing!.receipts;
    expect(receipts.map((receipt) => receipt.state)).toEqual(['moved', 'skipped']);
    expect(receipts[1]!.reason).toMatch(/same name/);
    expect(fs.existsSync(at('gas.pdf'))).toBe(true);
  });

  it('is idempotent: a second approve returns the same execution and never moves anything twice', async () => {
    const service = makeService();
    const task = await propose(service);
    const { planDigest } = proposal(task);
    const first = service.approveFiling(task.id, { planDigest }, owner);
    const second = service.approveFiling(task.id, { planDigest }, owner);
    expect(second.filing!.approvedAt).toBe(first.filing!.approvedAt);
    await service.whenIdle();
    // Put a file back where the first move took it from: a repeat would move it.
    fs.writeFileSync(at('power.pdf'), POWER);
    const third = service.approveFiling(task.id, { planDigest, overwrite: [] }, owner);
    await service.whenIdle();
    expect(third.filing!.receipts[0]!.state).toBe('moved');
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
    expect(service.get(task.id)!.activity.filter((entry) => entry.kind === 'filing-approved')).toHaveLength(1);
  });

  it('refuses to approve anything but a completed filing proposal', async () => {
    const service = makeService();
    const grant = service.createGrant(folder, owner);
    const inventory = service.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    await service.whenIdle();
    expect(refusal(() => service.approveFiling(inventory.id, { planDigest: 'x' }, owner)).code).toBe('invalid-state');
    expect(refusal(() => service.approveFiling('missing', { planDigest: 'x' }, owner)).code).toBe('not-found');
  });

  it('rechecks every file at move time: a changed source or a destination swapped for a link stays put', async () => {
    const service = makeService({ autoRun: false });
    const proposer = makeService();
    const task = await propose(proposer);
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest, overwrite: ['water.pdf'] }, owner);

    fs.writeFileSync(at('power.pdf'), buildTextPdf(['edited after the proposal']));
    fs.renameSync(at('Bills'), path.join(base, 'Bills-outside'));
    fs.symlinkSync(path.join(base, 'Bills-outside'), at('Bills'));
    service.recover();
    await service.whenIdle();

    const receipts = service.get(task.id)!.filing!.receipts;
    expect(receipts.map((receipt) => receipt.state)).toEqual(['failed', 'failed']);
    expect(receipts[0]!.reason).toMatch(/changed since the plan was proposed/);
    expect(receipts[1]!.reason).toMatch(/link/i);
    expect(fs.existsSync(at('water.pdf'))).toBe(true);
    expect(fs.readFileSync(path.join(base, 'Bills-outside', 'Water 2026-04.pdf'))).toEqual(OLD_WATER);
  });

  it('refuses replacing a target whose content changed after approval', async () => {
    const service = makeService({ autoRun: false });
    const task = await propose(makeService());
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest, overwrite: ['water.pdf'] }, owner);
    fs.writeFileSync(at('Bills/Water 2026-04.pdf'), buildTextPdf(['edited after approval']));
    service.recover();
    await service.whenIdle();
    expect(service.get(task.id)!.filing!.receipts[1]).toMatchObject({ state: 'failed', reason: expect.stringMatching(/changed since you approved/) });
    expect(fs.existsSync(at('water.pdf'))).toBe(true);
  });

  it('expires an approval that did not start in time, moving nothing', async () => {
    const service = makeService({ autoRun: false });
    const task = await propose(makeService());
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner);
    clock = new Date(clock.getTime() + FILING_APPROVAL_TTL_MS + 1);
    service.recover();
    await service.whenIdle();
    const done = service.get(task.id)!;
    expect(done.filing).toMatchObject({ state: 'expired' });
    expect(done.filing!.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringMatching(/expired/) });
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
    // Approving again returns the expired record; it never authorizes a new execution.
    expect(service.approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner).filing!.state).toBe('expired');
    await service.whenIdle();
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });

  it('stops at revocation: no file moves once access to the folder is revoked', async () => {
    const service = makeService({ autoRun: false });
    const task = await propose(makeService());
    service.approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner);
    service.revokeGrant(task.grant.id);
    service.recover();
    await service.whenIdle();
    expect(service.get(task.id)!.filing!.receipts.map((receipt) => receipt.state)).toEqual(['failed', 'skipped']);
    expect(service.get(task.id)!.filing!.receipts[0]!.reason).toMatch(/revoked/);
    expect(fs.existsSync(at('power.pdf'))).toBe(true);
  });
});

describe('restart recovery', () => {
  it('reconciles a move interrupted mid-way from the disk and never repeats a move', async () => {
    const file = path.join(base, 'agentdeck.db');
    store.close();
    store = new Store(file);
    const task = await propose(makeService());
    const before = makeService({ autoRun: false });
    const approved = before.approveFiling(task.id, { planDigest: proposal(task).planDigest, overwrite: ['water.pdf'] }, owner);
    expect(approved.filing!.state).toBe('approved');

    // Simulate a crash after the first file was linked into place but before its old name was removed.
    const approval = store.personal.getFilingApproval(task.id)!;
    store.personal.startFilingExecution(approval.id, clock.toISOString());
    store.personal.settleFilingReceipt(approval.id, 1, 'pending', 'moving', clock.toISOString());
    fs.mkdirSync(at('Bills/Power'));
    fs.linkSync(at('power.pdf'), at('Bills/Power/Power 2026-03.pdf'));
    store.close();

    store = new Store(file);
    const after = makeService();
    after.recover();
    await after.whenIdle();
    const done = after.get(task.id)!;
    expect(done.filing).toMatchObject({ state: 'finished' });
    expect(done.filing!.receipts.map((receipt) => receipt.state)).toEqual(['moved', 'failed']);
    expect(done.filing!.receipts[1]!.reason).toMatch(/stopped before this file was moved/);
    expect(fs.existsSync(at('power.pdf'))).toBe(false);
    expect(fs.readFileSync(at('Bills/Power/Power 2026-03.pdf'))).toEqual(POWER);
    // Not attempted after the restart: the water bill and its target are untouched.
    expect(fs.readFileSync(at('water.pdf'))).toEqual(WATER);
    expect(fs.readFileSync(at('Bills/Water 2026-04.pdf'))).toEqual(OLD_WATER);
    expect(done.activity.some((entry) => entry.kind === 'interrupted')).toBe(true);

    // A second restart changes nothing.
    const again = makeService();
    again.recover();
    await again.whenIdle();
    expect(again.get(task.id)).toEqual(done);
  });

  it('runs an approval that had not started yet when it is still in time', async () => {
    const task = await propose(makeService());
    makeService({ autoRun: false }).approveFiling(task.id, { planDigest: proposal(task).planDigest }, owner);
    const after = makeService();
    after.recover();
    await after.whenIdle();
    expect(after.get(task.id)!.filing!.receipts[0]!.state).toBe('moved');
    expect(fs.existsSync(at('Bills/Power/Power 2026-03.pdf'))).toBe(true);
  });
});
