// Runs personal tasks (CONTEXT.md) for the owner: folder grants, submission,
// attempts, ordered activity, and restart recovery. The only operation today
// is a PDF inventory that AgentDeck performs itself, one granted file at a
// time. No agent process is involved, so the confinement gate
// (src/confinement/decision.ts) is not consulted; a later agent-driven step
// must consult it before touching a grant.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersonalTaskRepository } from '../store/personal-tasks.js';
import { canonicalGrantRoot, GrantPathError, listGrantedPdfs, openGrantedPdf, type GrantedPdfListing } from './folder-grant.js';
import { inspectPdf, PdfTooLargeError, type InspectLimits } from './pdf-inventory.js';
import {
  OWNER_WORKSPACE, PERSONAL_TASK_POLICY_VERSION, type FolderGrant, type FolderGrantView, type PdfInventoryEntry,
  type PersonalActor, type PersonalTask, type PersonalTaskView,
} from './types.js';

export const DEFAULT_MAX_FILES_PER_TASK = 100;

export type PersonalTaskErrorCode = 'not-found' | 'grant-revoked' | 'invalid-input' | 'invalid-state';

export class PersonalTaskError extends Error {
  constructor(readonly code: PersonalTaskErrorCode, message: string, readonly path?: string) {
    super(message);
    this.name = 'PersonalTaskError';
  }
}

export interface PersonalTaskServiceOptions {
  repository: PersonalTaskRepository;
  homeDir?: string;
  /** Folders no grant may cover, such as AgentDeck's data directory. */
  protectedRoots?: readonly string[];
  maxFilesPerTask?: number;
  maxPdfBytes?: number;
  now?: () => Date;
  /** Test seam for the one bounded operation. */
  inspect?: (root: string, file: string, limits: InspectLimits) => PdfInventoryEntry;
  /** False only in tests that need a task to stay queued. */
  autoRun?: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeError(error: unknown): string {
  if (error instanceof GrantPathError || error instanceof PdfTooLargeError) return error.message;
  return 'The file could not be read.';
}

export class PersonalTaskService {
  private readonly repository: PersonalTaskRepository;
  private readonly homeDir: string;
  private readonly now: () => Date;
  private readonly inspect: NonNullable<PersonalTaskServiceOptions['inspect']>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PersonalTaskServiceOptions) {
    this.repository = options.repository;
    this.homeDir = options.homeDir ?? os.homedir();
    this.now = options.now ?? (() => new Date());
    this.inspect = options.inspect ?? inspectPdf;
  }

  private at(): string {
    return this.now().toISOString();
  }

  // -- grants --

  createGrant(selectedPath: string, actor: PersonalActor): FolderGrantView {
    const rootPath = canonicalGrantRoot(selectedPath, {
      homeDir: this.homeDir,
      ...(this.options.protectedRoots ? { protectedRoots: this.options.protectedRoots } : {}),
    });
    const grant: FolderGrant = { id: randomUUID(), rootPath, createdAt: this.at(), createdBy: actor };
    this.repository.insertGrant(grant);
    return this.grantView(grant);
  }

  listGrants(): FolderGrantView[] {
    return this.repository.listGrants().map((grant) => this.grantView(grant));
  }

  getGrant(id: string): FolderGrantView | undefined {
    const grant = this.repository.getGrant(id);
    return grant && this.grantView(grant);
  }

  revokeGrant(id: string): boolean {
    return this.repository.revokeGrant(id, this.at());
  }

  listGrantPdfs(grantId: string): GrantedPdfListing {
    return listGrantedPdfs(this.activeGrant(grantId).rootPath);
  }

  private activeGrant(grantId: string): FolderGrant {
    const grant = this.repository.getGrant(grantId);
    if (!grant) throw new PersonalTaskError('not-found', 'No such folder grant.');
    if (grant.revokedAt) throw new PersonalTaskError('grant-revoked', 'Access to this folder was revoked.');
    return grant;
  }

  // -- tasks --

  submitInventory(input: { grantId: string; files: readonly string[] }, actor: PersonalActor): PersonalTaskView {
    const grant = this.activeGrant(input.grantId);
    const max = this.options.maxFilesPerTask ?? DEFAULT_MAX_FILES_PER_TASK;
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new PersonalTaskError('invalid-input', 'Select at least one PDF.');
    }
    if (input.files.length > max) {
      throw new PersonalTaskError('invalid-input', `One task can inspect at most ${plural(max, 'PDF')}.`);
    }
    const files: string[] = [];
    for (const requested of input.files) {
      if (typeof requested !== 'string') throw new PersonalTaskError('invalid-input', 'File paths must be strings.');
      // The same canonical-path checks the attempt repeats before reading.
      const handle = openGrantedPdf(grant.rootPath, requested);
      fs.closeSync(handle.fd);
      if (!files.includes(handle.relativePath)) files.push(handle.relativePath);
    }
    const at = this.at();
    const task: PersonalTask = {
      id: randomUUID(),
      kind: 'pdf-inventory',
      workspace: OWNER_WORKSPACE,
      grantId: grant.id,
      policyVersion: PERSONAL_TASK_POLICY_VERSION,
      files,
      submittedAt: at,
      submittedBy: actor,
      status: 'queued',
      updatedAt: at,
    };
    this.repository.createTask(task, {
      at, kind: 'submitted', message: `${actor.principal.displayName} asked to inspect ${plural(files.length, 'PDF')} on ${actor.device.label}.`,
    });
    if (this.options.autoRun !== false) this.schedule(task.id);
    return this.get(task.id)!;
  }

  retry(taskId: string): PersonalTaskView {
    const task = this.repository.getTask(taskId);
    if (!task) throw new PersonalTaskError('not-found', 'No such task.');
    if (!this.repository.requeueFailed(taskId, this.at(), { at: this.at(), kind: 'retry-requested', message: 'Retry requested.' })) {
      throw new PersonalTaskError('invalid-state', 'Only a failed task can be retried.');
    }
    this.schedule(taskId);
    return this.get(taskId)!;
  }

  get(id: string): PersonalTaskView | undefined {
    const task = this.repository.getTask(id);
    return task && this.taskView(task);
  }

  list(): PersonalTaskView[] {
    return this.repository.listTasks().map((task) => this.taskView(task));
  }

  /**
   * Boot-time recovery. An attempt that was running when the process stopped
   * is ended as interrupted — never completed — and the task, which only
   * reads, is run again as a new attempt under the same identity.
   */
  recover(): void {
    for (const task of this.repository.listUnsettledTasks()) {
      const open = this.repository.listAttempts(task.id).filter((attempt) => !attempt.endedAt);
      for (const attempt of open) {
        this.repository.finishAttempt(task.id, attempt.id, this.at(), 'interrupted', {}, {
          at: this.at(), kind: 'interrupted', message: 'AgentDeck stopped during this attempt. No result was recorded; it will run again.',
        });
      }
      this.schedule(task.id);
    }
  }

  /** Resolves once every scheduled attempt has settled. */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private schedule(taskId: string): void {
    this.queue = this.queue.then(() => this.runAttempt(taskId)).catch(() => undefined);
  }

  private async runAttempt(taskId: string): Promise<void> {
    const task = this.repository.getTask(taskId);
    if (!task || task.status !== 'queued') return;
    const attempt = this.repository.startAttempt(taskId, randomUUID(), this.at(), {
      at: this.at(), kind: 'attempt-started', message: `Inspecting ${plural(task.files.length, 'PDF')}.`,
    });
    const fail = (failure: string) => this.repository.finishAttempt(taskId, attempt.id, this.at(), 'failed', { failure }, {
      at: this.at(), kind: 'failed', message: failure,
    });

    const files: PdfInventoryEntry[] = [];
    const skipped: { path: string; reason: string }[] = [];
    try {
      for (const file of task.files) {
        // Yield so a revocation or shutdown can land between files.
        await new Promise((resolve) => setImmediate(resolve));
        const grant = this.repository.getGrant(task.grantId);
        if (!grant || grant.revokedAt) {
          fail('Access to the folder was revoked. No further files were read.');
          return;
        }
        try {
          const entry = this.inspect(grant.rootPath, file, { maxBytes: this.options.maxPdfBytes });
          files.push(entry);
          this.repository.appendActivity(taskId, { at: this.at(), kind: 'file-inspected', message: `Inspected ${entry.name}.`, attemptId: attempt.id, path: file });
        } catch (error) {
          if (error instanceof GrantPathError && error.code === 'grant-unavailable') {
            fail(error.message);
            return;
          }
          const reason = describeError(error);
          skipped.push({ path: file, reason });
          this.repository.appendActivity(taskId, { at: this.at(), kind: 'file-skipped', message: `Skipped ${path.basename(file)}: ${reason}`, attemptId: attempt.id, path: file });
        }
      }
      const completedAt = this.at();
      this.repository.finishAttempt(taskId, attempt.id, completedAt, 'completed', {
        result: {
          attemptId: attempt.id,
          completedAt,
          files,
          skipped,
          totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
          knownPages: files.reduce((sum, entry) => sum + (entry.pageCount ?? 0), 0),
        },
      }, {
        at: completedAt,
        kind: 'completed',
        message: `Inventoried ${plural(files.length, 'PDF')}${skipped.length ? `, skipped ${skipped.length}` : ''}.`,
      });
    } catch {
      fail('The inventory stopped because of an unexpected error. No result was recorded.');
    }
  }

  // -- projections --

  private grantName(grant: FolderGrant): string {
    return path.basename(grant.rootPath);
  }

  private grantView(grant: FolderGrant): FolderGrantView {
    const home = this.homeDir.endsWith(path.sep) ? this.homeDir : this.homeDir + path.sep;
    const displayPath = grant.rootPath.startsWith(home) ? `~/${grant.rootPath.slice(home.length)}` : grant.rootPath;
    return {
      id: grant.id,
      name: this.grantName(grant),
      displayPath,
      createdAt: grant.createdAt,
      ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    };
  }

  private taskView(task: PersonalTask): PersonalTaskView {
    const grant = this.repository.getGrant(task.grantId);
    const grantName = grant ? this.grantName(grant) : 'Unknown folder';
    return {
      id: task.id,
      kind: task.kind,
      title: `Inspect ${plural(task.files.length, 'PDF')} in ${grantName}`,
      status: task.status,
      workspace: task.workspace,
      policyVersion: task.policyVersion,
      grant: { id: task.grantId, name: grantName, revoked: Boolean(grant?.revokedAt) },
      files: task.files,
      submittedAt: task.submittedAt,
      updatedAt: task.updatedAt,
      submittedBy: { displayName: task.submittedBy.principal.displayName, device: task.submittedBy.device.label },
      attempts: this.repository.listAttempts(task.id),
      activity: this.repository.listActivity(task.id),
      ...(task.failure ? { failure: task.failure } : {}),
      ...(task.result ? { result: task.result } : {}),
    };
  }
}
