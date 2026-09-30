// Saved routines (CONTEXT.md, issue #92). The owner saves a PDF or email
// request that worked and runs it again later. A routine is only the
// request: each run rechecks the Folder grant or Email account grant it
// names, then submits a brand-new personal task or email task through the
// same service calls the owner would use by hand. Approvals stay on those
// tasks — a filing approval is bound to one proposal's plan digest and a
// send to one draft version — so a routine never becomes standing authority
// to move files or send mail. A run that cannot start is recorded as blocked
// with what the owner can do about it.
import { randomUUID } from 'node:crypto';
import type { RoutineRepository } from '../../store/routines.js';
import type { EmailTaskService } from '../email/service.js';
import type { EmailAccountView } from '../email/types.js';
import { GrantPathError } from '../folder-grant.js';
import { DEFAULT_MAX_FILES_PER_TASK, PersonalTaskError, type PersonalTaskService } from '../service.js';
import type { PersonalActor, PersonalTaskStatus } from '../types.js';
import type { Routine, RoutineBlock, RoutineConfig, RoutineRun, RoutineRunView, RoutineTaskSource, RoutineView } from './types.js';

export type RoutineErrorCode = 'not-found' | 'invalid-input' | 'invalid-state' | 'grant-revoked' | 'account-revoked';

export class RoutineError extends Error {
  constructor(readonly code: RoutineErrorCode, message: string) {
    super(message);
    this.name = 'RoutineError';
  }
}

export interface RoutineServiceOptions {
  repository: RoutineRepository;
  personal: PersonalTaskService;
  email: EmailTaskService;
  now?: () => Date;
  maxFilesPerRun?: number;
}

const MAX_NAME = 80;
const UNSETTLED: readonly PersonalTaskStatus[] = ['queued', 'running'];
/** Account states the owner has to fix before mail can be read again; 'unchecked' and 'unreachable' are rechecked at run time. */
const NEEDS_REPAIR = new Set<EmailAccountView['state']>(['signed-out', 'missing-scope', 'unsupported', 'no-client', 'check-failed']);

const who = (actor: PersonalActor) => ({ displayName: actor.principal.displayName, device: actor.device.label });

export class RoutineService {
  private readonly repository: RoutineRepository;
  private readonly now: () => Date;
  /** Routines with a run between its checks and its submission, so two taps cannot start two tasks. */
  private readonly starting = new Set<string>();

  constructor(private readonly options: RoutineServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** Saves the request behind a task that worked, with the grant or account it used. */
  save(input: { name: unknown; source: unknown; taskId: unknown }, actor: PersonalActor): RoutineView {
    const name = this.name(input.name);
    if (typeof input.taskId !== 'string' || !input.taskId) throw new RoutineError('invalid-input', 'Choose the task to save.');
    let config: RoutineConfig;
    if (input.source === 'personal') {
      const task = this.options.personal.get(input.taskId);
      if (!task) throw new RoutineError('not-found', 'No such task.');
      if (task.status !== 'completed') throw new RoutineError('invalid-state', 'Save a routine from a task that finished.');
      config = { kind: task.kind, grantId: task.grant.id };
    } else if (input.source === 'email') {
      const task = this.options.email.get(input.taskId);
      if (!task) throw new RoutineError('not-found', 'No such task.');
      if (task.status !== 'completed') throw new RoutineError('invalid-state', 'Save a routine from a search that found the email.');
      config = { kind: 'email-reply', accountId: task.account.id, request: task.request };
    } else {
      throw new RoutineError('invalid-input', 'source must be personal or email.');
    }
    this.assertTargetActive(config);
    const at = this.at();
    const routine: Routine = { id: randomUUID(), name, config, sourceTaskId: input.taskId, createdAt: at, createdBy: actor, updatedAt: at };
    this.repository.insert(routine);
    return this.view(routine);
  }

  list(): RoutineView[] {
    return this.repository.list().map((routine) => this.view(routine));
  }

  get(id: string): RoutineView | undefined {
    const routine = this.repository.get(id);
    return routine && !routine.deletedAt ? this.view(routine) : undefined;
  }

  /** Renames a routine, or points it at a folder or account chosen again after a revocation. */
  update(id: string, change: { name?: unknown; grantId?: unknown; accountId?: unknown }): RoutineView {
    const routine = this.live(id);
    const name = change.name === undefined ? routine.name : this.name(change.name);
    let config = routine.config;
    if (change.grantId !== undefined) {
      if (config.kind === 'email-reply') throw new RoutineError('invalid-input', 'An email routine uses a Gmail account, not a folder.');
      if (typeof change.grantId !== 'string' || !change.grantId) throw new RoutineError('invalid-input', 'Choose a folder.');
      config = { ...config, grantId: change.grantId };
    }
    if (change.accountId !== undefined) {
      if (config.kind !== 'email-reply') throw new RoutineError('invalid-input', 'A PDF routine uses a folder, not a Gmail account.');
      if (typeof change.accountId !== 'string' || !change.accountId) throw new RoutineError('invalid-input', 'Choose a Gmail account.');
      config = { ...config, accountId: change.accountId };
    }
    if (config !== routine.config) this.assertTargetActive(config);
    this.repository.update(id, { name, config }, this.at());
    return this.view(this.repository.get(id)!);
  }

  /** Stops the routine being run. Its runs, and the tasks and results they link to, are kept. */
  remove(id: string): void {
    if (!this.repository.markDeleted(id, this.at())) throw new RoutineError('not-found', 'No such routine.');
  }

  /**
   * Rechecks the routine's grant or account, then starts one new task. A
   * check that fails records a blocked run with its repair and starts nothing.
   */
  async run(id: string, actor: PersonalActor): Promise<RoutineRunView> {
    const routine = this.live(id);
    const last = this.repository.listRuns(id)[0];
    if (this.starting.has(id) || (last?.task && UNSETTLED.includes(this.taskSummary(last.task)?.status ?? 'completed'))) {
      throw new RoutineError('invalid-state', 'The last run of this routine has not finished yet.');
    }
    this.starting.add(id);
    try {
      const config = routine.config;
      const outcome = config.kind === 'email-reply' ? await this.startEmail(config, actor) : this.startPersonal(config, actor);
      const run = this.repository.recordRun({
        id: randomUUID(), routineId: id, at: this.at(), by: actor, config,
        ...('block' in outcome ? { outcome: 'blocked', block: outcome.block } : { outcome: 'started', task: outcome.task }),
      });
      return this.runView(run);
    } finally {
      this.starting.delete(id);
    }
  }

  // -- starting a run --

  private startPersonal(config: Extract<RoutineConfig, { grantId: string }>, actor: PersonalActor): Started {
    const { personal } = this.options;
    const block = this.folderBlock(config.grantId);
    if (block) return { block };
    const name = personal.getGrant(config.grantId)!.name;
    const filing = config.kind === 'pdf-filing-proposal';
    let files: string[];
    try {
      // Filing takes what is loose in the folder, so what an earlier run filed into a sub-folder is not proposed again.
      files = personal.listGrantPdfs(config.grantId, filing ? { maxDepth: 1 } : {}).files.map((file) => file.relativePath);
    } catch (error) {
      return { block: this.personalFailure(error, name) };
    }
    if (files.length === 0) {
      return { block: { code: 'nothing-to-run', message: filing ? `No PDFs are waiting directly in ${name}.` : `${name} has no PDFs.` } };
    }
    files = files.slice(0, this.options.maxFilesPerRun ?? DEFAULT_MAX_FILES_PER_TASK);
    try {
      const input = { grantId: config.grantId, files };
      const task = filing ? personal.submitFilingProposal(input, actor) : personal.submitInventory(input, actor);
      return { task: { source: 'personal', id: task.id } };
    } catch (error) {
      return { block: this.personalFailure(error, name) };
    }
  }

  private personalFailure(error: unknown, name: string): RoutineBlock {
    if (error instanceof PersonalTaskError && (error.code === 'grant-revoked' || error.code === 'not-found')) return revokedFolder(name);
    if (error instanceof GrantPathError && error.code === 'grant-unavailable') {
      return { code: 'folder-unavailable', message: `${name} was moved, replaced, or removed. Choose the folder again, then point this routine at it.` };
    }
    throw error;
  }

  private async startEmail(config: Extract<RoutineConfig, { kind: 'email-reply' }>, actor: PersonalActor): Promise<Started> {
    const { email } = this.options;
    const revoked = this.accountBlock(config.accountId, { recheck: true });
    if (revoked) return { block: revoked };
    // A fresh check each run: a sign-in that expired since the last run is found here, not partway through the search.
    const account = await email.checkAccount(config.accountId).catch(() => undefined);
    if (!account || account.revokedAt) return { block: this.accountBlock(config.accountId) ?? revokedAccount() };
    if (account.state !== 'ready') return { block: accountRepair(account) };
    try {
      const task = email.submit({ accountId: config.accountId, request: config.request }, actor);
      return { task: { source: 'email', id: task.id } };
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'account-revoked' || error.code === 'not-found')) return { block: revokedAccount(account.address) };
      throw error;
    }
  }

  // -- checks --

  private folderBlock(grantId: string): RoutineBlock | undefined {
    const grant = this.options.personal.getGrant(grantId);
    if (!grant || grant.revokedAt) return revokedFolder(grant?.name ?? 'The folder');
    return undefined;
  }

  /** Without a recheck, a state the owner must fix counts; with one, only revocation does, as the check comes next. */
  private accountBlock(accountId: string, options: { recheck?: boolean } = {}): RoutineBlock | undefined {
    const account = this.options.email.listAccounts().find((entry) => entry.id === accountId);
    if (!account || account.revokedAt) return revokedAccount(account?.address);
    if (!options.recheck && NEEDS_REPAIR.has(account.state)) return accountRepair(account);
    return undefined;
  }

  private assertTargetActive(config: RoutineConfig): void {
    if (config.kind === 'email-reply') {
      const account = this.options.email.listAccounts().find((entry) => entry.id === config.accountId);
      if (!account) throw new RoutineError('not-found', 'No such Gmail account.');
      if (account.revokedAt) throw new RoutineError('account-revoked', 'Access to this Gmail account was revoked. Reconnect it first.');
      return;
    }
    const grant = this.options.personal.getGrant(config.grantId);
    if (!grant) throw new RoutineError('not-found', 'No such folder grant.');
    if (grant.revokedAt) throw new RoutineError('grant-revoked', 'Access to this folder was revoked. Choose the folder again first.');
  }

  private live(id: string): Routine {
    const routine = this.repository.get(id);
    if (!routine || routine.deletedAt) throw new RoutineError('not-found', 'No such routine.');
    return routine;
  }

  private name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new RoutineError('invalid-input', 'Give the routine a name.');
    const name = value.trim();
    if (name.length > MAX_NAME) throw new RoutineError('invalid-input', `Keep the name under ${MAX_NAME} characters.`);
    return name;
  }

  // -- views --

  private view(routine: Routine): RoutineView {
    const { config } = routine;
    let target: RoutineView['target'];
    let repair: RoutineBlock | undefined;
    if (config.kind === 'email-reply') {
      const account = this.options.email.listAccounts().find((entry) => entry.id === config.accountId);
      target = { id: config.accountId, label: account?.address ?? 'Unknown account', revoked: !account || Boolean(account.revokedAt) };
      repair = this.accountBlock(config.accountId);
    } else {
      const grant = this.options.personal.getGrant(config.grantId);
      target = { id: config.grantId, label: grant?.name ?? 'Unknown folder', revoked: !grant || Boolean(grant.revokedAt) };
      repair = this.folderBlock(config.grantId);
    }
    return {
      id: routine.id,
      name: routine.name,
      kind: config.kind,
      target,
      ...(config.kind === 'email-reply' ? { request: config.request } : {}),
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
      ...(repair ? { repair } : {}),
      runs: this.repository.listRuns(routine.id).map((run) => this.runView(run)),
    };
  }

  private runView(run: RoutineRun): RoutineRunView {
    const task = run.task && this.taskSummary(run.task);
    return {
      id: run.id,
      sequence: run.sequence,
      at: run.at,
      by: who(run.by),
      outcome: run.outcome,
      ...(run.block ? { block: run.block } : {}),
      ...(run.task ? { task: { ...run.task, title: task?.title ?? 'Task no longer available', status: task?.status ?? 'failed' } } : {}),
    };
  }

  private taskSummary(task: { source: RoutineTaskSource; id: string }): { title: string; status: PersonalTaskStatus } | undefined {
    return task.source === 'personal' ? this.options.personal.get(task.id) : this.options.email.get(task.id);
  }
}

type Started = { task: { source: RoutineTaskSource; id: string } } | { block: RoutineBlock };

function revokedFolder(name: string): RoutineBlock {
  return { code: 'folder-revoked', message: `Access to ${name} was revoked. Choose the folder again in Personal tasks, then point this routine at it.` };
}

function revokedAccount(address = 'this Gmail account'): RoutineBlock {
  return { code: 'account-revoked', message: `Access to ${address} was revoked. Reconnect Gmail, then point this routine at it.` };
}

function accountRepair(account: EmailAccountView): RoutineBlock {
  const why = account.detail ? `${account.detail} ` : '';
  return { code: 'account-needs-repair', message: `${why}${account.repair ?? 'Check the Gmail connection.'}`.trim() };
}
