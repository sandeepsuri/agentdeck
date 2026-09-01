import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import { createRuntimeReadinessSource, type RuntimeReadinessSource } from '../sessions/runtime-readiness.js';
import type { Store } from '../store/index.js';
import type { Task } from '../types.js';
import { buildRunEnvelope } from './envelope.js';
import { prepareRunWorktree, RunPreparationError } from './prepare.js';
import type { WorkEngine, WorkRun, WorkSpec } from './types.js';

// Re-exported so callers (e.g. the REST adapter) reach every error prepare()
// can throw through this one module, keeping prepare.ts an internal detail.
export { RunPreparationError };

export class InvalidWorkSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkSpecError';
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`no such run: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class InvalidRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRunStateError';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateWorkSpec(input: WorkSpec): void {
  const spec = input as unknown as Record<string, unknown>;
  if (!nonEmptyString(spec.objective)) throw new InvalidWorkSpecError('objective must be a non-empty string');
  if (!Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0
    || !spec.acceptanceCriteria.every(nonEmptyString)) {
    throw new InvalidWorkSpecError('acceptanceCriteria must contain at least one non-empty string');
  }
  const repository = spec.repository as Record<string, unknown> | undefined;
  if (!repository || !nonEmptyString(repository.id) || !nonEmptyString(repository.name)
    || !nonEmptyString(repository.path)) {
    throw new InvalidWorkSpecError('repository must include non-empty id, name, and path');
  }
  if (!nonEmptyString(spec.requestedBaseReference)) {
    throw new InvalidWorkSpecError('requestedBaseReference must be a non-empty string');
  }
  if (!Array.isArray(spec.runtimePreference) || spec.runtimePreference.length === 0
    || !spec.runtimePreference.every((runtime) => runtime === 'codex' || runtime === 'claude')) {
    throw new InvalidWorkSpecError('runtimePreference must contain codex or claude');
  }
  const budget = spec.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || !Object.values(budget).every((limit) => typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
    throw new InvalidWorkSpecError('budget limits must be positive finite numbers');
  }
  const verification = spec.verificationIntent as Record<string, unknown> | undefined;
  if (!verification || typeof verification.required !== 'boolean' || !Array.isArray(verification.commands)
    || !verification.commands.every(nonEmptyString)) {
    throw new InvalidWorkSpecError('verificationIntent must include required and string commands');
  }
  if (verification.required && verification.commands.length === 0) {
    throw new InvalidWorkSpecError('verificationIntent.commands is required when verification is required');
  }
  if (spec.requestedDeliveryResult !== 'working-tree' && spec.requestedDeliveryResult !== 'local-commit'
    && spec.requestedDeliveryResult !== 'pull-request') {
    throw new InvalidWorkSpecError('requestedDeliveryResult is invalid');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const TERMINAL_STATUSES: ReadonlySet<WorkRun['status']> = new Set(['completed', 'failed', 'cancelled']);

/** Durable entry point for submitting and reopening managed work. */
export class DurableWorkEngine implements WorkEngine {
  private readonly runsRoot: string;
  private readonly runtimeReadiness: RuntimeReadinessSource;

  constructor(
    private readonly store: Store,
    runsRoot: string = path.join(defaultDataDir(), 'runs'),
    runtimeReadiness: RuntimeReadinessSource = createRuntimeReadinessSource(),
  ) {
    this.runsRoot = runsRoot;
    this.runtimeReadiness = runtimeReadiness;
  }

  async submit(input: WorkSpec): Promise<WorkRun> {
    validateWorkSpec(input);
    const knownRepository = this.store.listRepos().find((repository) => repository.id === input.repository.id);
    if (!knownRepository || knownRepository.path !== input.repository.path
      || knownRepository.name !== input.repository.name) {
      throw new InvalidWorkSpecError('repository is not known to AgentDeck');
    }
    const spec = frozenCopy(input);
    const taskId = randomUUID();
    const run = frozenCopy<WorkRun>({
      id: randomUUID(),
      taskId,
      status: 'queued',
      spec,
      submittedAt: new Date().toISOString(),
      preparation: { state: 'pending' },
      envelope: { state: 'pending' },
    });
    const task: Task = {
      id: taskId,
      title: spec.objective,
      objective: spec.objective,
      acceptanceCriteria: [...spec.acceptanceCriteria],
      repoId: spec.repository.id,
      status: 'todo',
      sessionIds: [],
    };

    this.store.createTaskAndRun(task, run);
    return run;
  }

  get(runId: string): WorkRun | undefined {
    const run = this.store.getRun(runId);
    return run ? frozenCopy(run) : undefined;
  }

  list(): WorkRun[] {
    return this.store.listRuns().map(frozenCopy);
  }

  async prepare(runId: string): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new InvalidRunStateError(`cannot prepare a Run in terminal status: ${existing.status}`);
    }
    // Ready worktrees are never recreated (their path/branch would collide
    // with themselves) — a repeated call, e.g. after a restart, is a no-op.
    if (existing.preparation.state === 'ready') return frozenCopy(existing);

    this.store.updateRun(frozenCopy<WorkRun>({
      ...existing, status: 'preparing', preparation: { state: 'in_progress' },
    }));

    try {
      const prepared = await prepareRunWorktree(
        existing.spec.repository, existing.spec.requestedBaseReference, existing.id, this.runsRoot,
      );
      // Ticket 04: freeze the capability envelope the instant the worktree
      // it's scoped to exists, before any runtime can receive authority.
      const envelope = buildRunEnvelope({
        runtimePreference: existing.spec.runtimePreference,
        readiness: await this.runtimeReadiness.get(),
        worktreePath: prepared.worktreePath,
      });
      const ready = frozenCopy<WorkRun>({
        ...existing, status: 'preparing', preparation: { state: 'ready', ...prepared }, envelope,
      });
      this.store.updateRun(ready);
      return ready;
    } catch (error) {
      // The failure stays recoverable: status remains 'preparing' (not the
      // terminal 'failed') so a later prepare() call can retry once the
      // reported collision or Git failure is addressed.
      const failed = frozenCopy<WorkRun>({
        ...existing,
        status: 'preparing',
        preparation: { state: 'failed', error: error instanceof Error ? error.message : String(error) },
      });
      this.store.updateRun(failed);
      throw error;
    }
  }

  async cancel(runId: string): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    // Cancellation never touches a prepared worktree — it is only a status
    // change, and stays that way regardless of what preparation recorded.
    if (TERMINAL_STATUSES.has(existing.status)) return frozenCopy(existing);
    const cancelled = frozenCopy<WorkRun>({ ...existing, status: 'cancelled' });
    this.store.updateRun(cancelled);
    return cancelled;
  }
}
