import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { inspectPdf } from './pdf-inventory.js';
import { PersonalTaskError, PersonalTaskService, type PersonalTaskServiceOptions } from './service.js';
import { OWNER_WORKSPACE, PERSONAL_TASK_POLICY_VERSION, type PersonalActor } from './types.js';

const PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 2 >>\nendobj\n%%EOF\n';
const owner: PersonalActor = { principal: { id: 'local:owner', displayName: 'owner' }, device: { id: 'local', label: 'This Mac' } };

let base: string;
let home: string;
let folder: string;
let stores: Store[];

function write(file: string, content = PDF): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeService(store: Store, options: Partial<PersonalTaskServiceOptions> = {}): PersonalTaskService {
  return new PersonalTaskService({ repository: store.personal, homeDir: home, ...options });
}

function openStore(file = ':memory:'): Store {
  const store = new Store(file);
  stores.push(store);
  return store;
}

async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

beforeEach(() => {
  stores = [];
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-personal-')));
  home = path.join(base, 'home');
  folder = path.join(home, 'Documents', 'Bills');
  write(path.join(folder, 'power.pdf'));
  write(path.join(folder, 'water.pdf'));
  write(path.join(folder, 'notes.txt'), 'text');
  write(path.join(home, 'Private', 'secret.pdf'));
});

afterEach(() => {
  for (const store of stores) store.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('folder grants', () => {
  it('creates a canonical grant and projects it without the absolute path', () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    expect(grant).toEqual({ id: expect.any(String), name: 'Bills', displayPath: '~/Documents/Bills', createdAt: expect.any(String) });
    expect(JSON.stringify(service.listGrants())).not.toContain(base);
  });

  it('refuses a folder that is too broad', () => {
    const service = makeService(openStore());
    expect(() => service.createGrant(home, owner)).toThrowError(expect.objectContaining({ code: 'too-broad' }));
  });

  it('lists PDFs in an active grant and refuses once it is revoked', () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    expect(service.listGrantPdfs(grant.id).files.map((file) => file.relativePath)).toEqual(['power.pdf', 'water.pdf']);
    expect(service.revokeGrant(grant.id)).toBe(true);
    expect(service.revokeGrant(grant.id)).toBe(false);
    expect(() => service.listGrantPdfs(grant.id)).toThrowError(expect.objectContaining({ code: 'grant-revoked' }));
    expect(service.listGrants()[0]!.revokedAt).toEqual(expect.any(String));
  });
});

describe('inventory tasks', () => {
  it('runs a submitted inventory and records who, where, which grant, activity, and the result', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    const submitted = service.submitInventory({ grantId: grant.id, files: ['water.pdf', 'power.pdf', 'power.pdf'] }, owner);
    expect(submitted.status).toBe('queued');
    expect(submitted.files).toEqual(['water.pdf', 'power.pdf']);
    await service.whenIdle();

    const task = service.get(submitted.id)!;
    expect(task).toMatchObject({
      id: submitted.id,
      kind: 'pdf-inventory',
      status: 'completed',
      workspace: OWNER_WORKSPACE,
      policyVersion: PERSONAL_TASK_POLICY_VERSION,
      grant: { id: grant.id, name: 'Bills', revoked: false },
      submittedBy: { displayName: 'owner', device: 'This Mac' },
    });
    expect(task.attempts).toEqual([expect.objectContaining({ sequence: 1, outcome: 'completed' })]);
    expect(task.activity.map((entry) => entry.kind)).toEqual(['submitted', 'attempt-started', 'file-inspected', 'file-inspected', 'completed']);
    expect(task.activity.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(task.result).toMatchObject({ attemptId: task.attempts[0]!.id, totalBytes: PDF.length * 2, knownPages: 4, skipped: [] });
    expect(task.result!.files.map((file) => file.name)).toEqual(['water.pdf', 'power.pdf']);
    expect(JSON.stringify(service.list())).not.toContain(base);
  });

  it('rejects submissions outside the grant, through symlinks, of unsupported files, and of nothing', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    fs.symlinkSync(path.join(home, 'Private', 'secret.pdf'), path.join(folder, 'link.pdf'));
    const cases: [string[], string][] = [
      [['../../Private/secret.pdf'], 'outside-grant'],
      [[path.join(home, 'Private', 'secret.pdf')], 'outside-grant'],
      [['link.pdf'], 'symlink'],
      [['notes.txt'], 'unsupported-type'],
      [[], 'invalid-input'],
    ];
    for (const [files, code] of cases) {
      const error = await thrown(() => service.submitInventory({ grantId: grant.id, files }, owner));
      expect(error).toMatchObject({ code });
    }
    expect(await thrown(() => service.submitInventory({ grantId: 'missing', files: ['power.pdf'] }, owner))).toMatchObject({ code: 'not-found' });
    expect(service.list()).toEqual([]);
  });

  it('refuses more files than one task may inspect', async () => {
    const service = makeService(openStore(), { maxFilesPerTask: 1 });
    const grant = service.createGrant(folder, owner);
    const error = await thrown(() => service.submitInventory({ grantId: grant.id, files: ['power.pdf', 'water.pdf'] }, owner));
    expect(error).toBeInstanceOf(PersonalTaskError);
    expect(error).toMatchObject({ code: 'invalid-input' });
  });

  it('refuses to submit against a revoked grant', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    service.revokeGrant(grant.id);
    expect(await thrown(() => service.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner))).toMatchObject({ code: 'grant-revoked' });
  });

  it('stops reading as soon as the grant is revoked mid-inventory', async () => {
    let service!: PersonalTaskService;
    let grantId = '';
    const read: string[] = [];
    service = makeService(openStore(), {
      inspect: (root, file, limits) => {
        read.push(file);
        service.revokeGrant(grantId);
        return inspectPdf(root, file, limits);
      },
    });
    grantId = service.createGrant(folder, owner).id;
    const { id } = service.submitInventory({ grantId, files: ['power.pdf', 'water.pdf'] }, owner);
    await service.whenIdle();
    const task = service.get(id)!;
    expect(read).toEqual(['power.pdf']);
    expect(task.status).toBe('failed');
    expect(task.failure).toMatch(/revoked/);
    expect(task.result).toBeUndefined();
    expect(task.grant.revoked).toBe(true);
  });

  it('skips a file that changed after submission and still completes', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    const { id } = service.submitInventory({ grantId: grant.id, files: ['power.pdf', 'water.pdf'] }, owner);
    fs.rmSync(path.join(folder, 'water.pdf'));
    await service.whenIdle();
    const task = service.get(id)!;
    expect(task.status).toBe('completed');
    expect(task.result!.files.map((file) => file.name)).toEqual(['power.pdf']);
    expect(task.result!.skipped).toEqual([{ path: 'water.pdf', reason: expect.stringMatching(/no longer exists/) }]);
    expect(task.activity.find((entry) => entry.kind === 'file-skipped')?.path).toBe('water.pdf');
  });

  it('fails the task when the granted folder disappears', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    const { id } = service.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    fs.rmSync(folder, { recursive: true });
    await service.whenIdle();
    expect(service.get(id)).toMatchObject({ status: 'failed', failure: expect.stringMatching(/moved, replaced, or removed/) });
  });

  it('retries a failed task as a new attempt under the same identity', async () => {
    const service = makeService(openStore());
    const grant = service.createGrant(folder, owner);
    const { id } = service.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    fs.renameSync(folder, `${folder}-away`);
    await service.whenIdle();
    expect(service.get(id)!.status).toBe('failed');
    await thrown(() => service.retry('missing'));
    fs.renameSync(`${folder}-away`, folder);
    expect(service.retry(id).id).toBe(id);
    await service.whenIdle();
    const task = service.get(id)!;
    expect(task.status).toBe('completed');
    expect(task.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'completed']);
    expect(task.result!.attemptId).toBe(task.attempts[1]!.id);
    expect(await thrown(() => service.retry(id))).toMatchObject({ code: 'invalid-state' });
  });
});

describe('restart recovery', () => {
  it('ends an interrupted attempt without a result and re-runs the same task after restart', async () => {
    const dbFile = path.join(base, 'agentdeck.db');
    const first = openStore(dbFile);
    const before = makeService(first, { autoRun: false });
    const grant = before.createGrant(folder, owner);
    const { id } = before.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    // Simulate a crash mid-attempt: the attempt started, nothing finished.
    first.personal.startAttempt(id, 'attempt-crashed', new Date().toISOString(), { at: new Date().toISOString(), kind: 'attempt-started', message: 'Inspecting 1 PDF.' });
    first.close();
    stores = stores.filter((store) => store !== first);

    const second = openStore(dbFile);
    const after = makeService(second);
    const interrupted = second.personal.getTask(id)!;
    expect(interrupted).toMatchObject({ status: 'running' });
    expect(interrupted.result).toBeUndefined();

    after.recover();
    await after.whenIdle();
    const task = after.get(id)!;
    expect(task.id).toBe(id);
    expect(task.status).toBe('completed');
    expect(task.attempts.map((attempt) => [attempt.id === 'attempt-crashed', attempt.outcome])).toEqual([[true, 'interrupted'], [false, 'completed']]);
    expect(task.result!.attemptId).not.toBe('attempt-crashed');
    expect(task.activity.map((entry) => entry.kind)).toEqual(['submitted', 'attempt-started', 'interrupted', 'attempt-started', 'file-inspected', 'completed']);
  });

  it('keeps a completed result readable after restart', async () => {
    const dbFile = path.join(base, 'agentdeck.db');
    const first = openStore(dbFile);
    const before = makeService(first);
    const grant = before.createGrant(folder, owner);
    const { id } = before.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    await before.whenIdle();
    const result = before.get(id)!.result;
    first.close();
    stores = stores.filter((store) => store !== first);

    const after = makeService(openStore(dbFile));
    after.recover();
    await after.whenIdle();
    expect(after.get(id)).toMatchObject({ status: 'completed', result });
    expect(after.get(id)!.attempts).toHaveLength(1);
  });

  it('does not read after restart when the grant was revoked', async () => {
    const dbFile = path.join(base, 'agentdeck.db');
    const first = openStore(dbFile);
    const before = makeService(first, { autoRun: false });
    const grant = before.createGrant(folder, owner);
    const { id } = before.submitInventory({ grantId: grant.id, files: ['power.pdf'] }, owner);
    before.revokeGrant(grant.id);
    first.close();
    stores = stores.filter((store) => store !== first);

    const read: string[] = [];
    const after = makeService(openStore(dbFile), { inspect: (root, file) => { read.push(file); return inspectPdf(root, file); } });
    after.recover();
    await after.whenIdle();
    expect(read).toEqual([]);
    expect(after.get(id)).toMatchObject({ status: 'failed', failure: expect.stringMatching(/revoked/) });
    expect(after.get(id)!.result).toBeUndefined();
  });
});
