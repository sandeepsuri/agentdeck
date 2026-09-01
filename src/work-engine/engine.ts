import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import { createRuntimeReadinessSource, type RuntimeReadinessSource } from '../sessions/runtime-readiness.js';
import type { Store } from '../store/index.js';
import type { AgentType, Task } from '../types.js';
import { buildAttemptEventEnvelope } from './durable-events.js';
import { buildRunEnvelope } from './envelope.js';
import { prepareRunWorktree, RunPreparationError } from './prepare.js';
import { describeUnrecoverableAttempt } from './recovery.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import type { AttemptLaunchContext, RuntimeAttemptAdapter } from './runtimes/adapter.js';
import type {
  AttemptAttentionResolvedEvent, AttemptEvent, AttentionDecisionInput, CapabilityEnvelope, WorkEngine, WorkRun, WorkSpec,
} from './types.js';

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

/** No RuntimeAttemptAdapter is wired for the Run's envelope runtime (ticket 05 wires Codex only; ticket 14 adds Claude). */
export class UnsupportedRuntimeError extends Error {
  constructor(runtime: AgentType) {
    super(`no runtime adapter is available for: ${runtime}`);
    this.name = 'UnsupportedRuntimeError';
  }
}

/**
 * Ticket 07 AC3/AC4: attentionId does not name the Run's current pending
 * attention request — already resolved, denied, superseded, or the Attempt
 * ended (including via recover() ending a Run left waiting when the
 * previous process stopped) — so there is nothing left to resolve exactly
 * once, and never anything to reopen.
 */
export class RunAttentionNotPendingError extends Error {
  constructor(runId: string, attentionId: string) {
    super(`Run ${runId} has no pending attention request ${attentionId} to resolve.`);
    this.name = 'RunAttentionNotPendingError';
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
  private readonly runtimeAdapters: Partial<Record<AgentType, RuntimeAttemptAdapter>>;
  /**
   * Ticket 07: the live in-process handle for each Run currently mid-
   * Attempt, keyed by runId — the only place a pending attention request
   * can actually be delivered to the runtime adapter that is awaiting it.
   * Never survives a restart (a fresh DurableWorkEngine starts with an
   * empty map, same as every other in-memory Attempt task — see recovery.ts):
   * resolveAttention() against a Run with no live entry here fails precisely
   * rather than pretending to deliver a decision nothing can receive.
   */
  private readonly liveAttempts = new Map<string, {
    persistResolution(attentionId: string, decision: AttentionDecisionInput): AttemptAttentionResolvedEvent;
    deliverDecision(attentionId: string, decision: AttentionDecisionInput): boolean;
  }>();

  constructor(
    private readonly store: Store,
    runsRoot: string = path.join(defaultDataDir(), 'runs'),
    runtimeReadiness: RuntimeReadinessSource = createRuntimeReadinessSource(),
    runtimeAdapters: Partial<Record<AgentType, RuntimeAttemptAdapter>> = { codex: createCodexAttemptAdapter() },
  ) {
    this.runsRoot = runsRoot;
    this.runtimeReadiness = runtimeReadiness;
    this.runtimeAdapters = runtimeAdapters;
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
      attempt: { state: 'idle' },
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

  async start(runId: string): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new InvalidRunStateError(`cannot start an Attempt for a Run in terminal status: ${existing.status}`);
    }
    if (existing.preparation.state !== 'ready') {
      throw new InvalidRunStateError('cannot start an Attempt before the Run worktree is prepared');
    }
    if (existing.envelope.state !== 'ready') {
      throw new InvalidRunStateError('cannot start an Attempt without a ready capability envelope');
    }
    if (existing.attempt.state !== 'idle') {
      throw new InvalidRunStateError(`an Attempt has already been started for this Run (${existing.attempt.state})`);
    }
    const { capabilityEnvelope } = existing.envelope;
    const adapter = this.runtimeAdapters[capabilityEnvelope.runtime];
    if (!adapter) throw new UnsupportedRuntimeError(capabilityEnvelope.runtime);

    // Ticket 06: the Attempt's identity and durable event log are their own
    // records (attempts/attempt_events) from the instant it starts — status
    // 'running' follows immediately once Store folds them in (see
    // Store.attachAttempt), with no separate write needed here.
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    this.store.startAttempt({
      id: attemptId, runId: existing.id, runtime: capabilityEnvelope.runtime, startedAt,
    });

    // Fire-and-forget: the Attempt itself can run far longer than an HTTP
    // request should block for. Progress is observed by rereading the Run
    // (get/list), never by awaiting this call.
    void this.runAttempt(existing, attemptId, adapter, capabilityEnvelope);
    return this.get(existing.id)!;
  }

  private async runAttempt(
    base: WorkRun,
    attemptId: string,
    adapter: RuntimeAttemptAdapter,
    envelope: CapabilityEnvelope,
  ): Promise<void> {
    let lastSequence = -1;
    // Ticket 07: the sole authority for a persisted event's sequence number
    // — whatever `event.sequence` the caller attached (the adapter's own
    // running counter, or a placeholder from persistResolution/
    // persistSynthesizedFailure below) is discarded and replaced with
    // `lastSequence + 1` here. This closes a real race: the adapter's
    // internal counter and an externally triggered resolveAttention() call
    // are two independent writers that can't otherwise agree on "the next
    // number" — an event minted by resolveAttention (running on its own
    // call stack, not the adapter's) could otherwise reuse a sequence the
    // adapter's own counter was about to hand to its next event, and
    // `INSERT OR IGNORE` on attempt_events' (attempt_id, sequence) primary
    // key would silently drop whichever write lost that race. Because
    // every event — adapter-yielded or engine-injected — funnels through
    // this one synchronous function, and JS never interleaves two
    // synchronous call stacks, centralizing assignment here instead makes
    // collision structurally impossible.
    const persistEvent = (event: AttemptEvent): AttemptEvent => {
      const sequenced = { ...event, sequence: lastSequence + 1 };
      lastSequence = sequenced.sequence;
      const eventEnvelope = buildAttemptEventEnvelope({ runId: base.id, attemptId, event: sequenced });
      // No AttemptEvent kind is transient today (durable-events.ts) — this
      // guard is where a future message-delta or raw-output kind would be
      // dropped rather than persisted as source-of-truth history (ticket 06
      // AC3), so it stays even though it can never trigger yet.
      if (eventEnvelope.durability === 'durable') this.store.appendAttemptEvent(eventEnvelope);
      return sequenced;
    };
    const persistSynthesizedFailure = (reason: string, at: string = new Date().toISOString()): void => {
      persistEvent({
        kind: 'failure', sequence: 0, at, reason,
      });
    };

    // Ticket 07: registered before the adapter ever runs so a decision made
    // the instant an attention-requested event lands can never race ahead of
    // this map having an entry for it.
    const attentionResolvers = new Map<string, (decision: AttentionDecisionInput) => void>();
    this.liveAttempts.set(base.id, {
      // Runs on the SAME synchronous call stack as resolveAttention() (no
      // await between its own read-then-append there and this call), so two
      // resolutions for the same request can never both observe it as
      // pending — the second always sees the first's durable event already
      // written by the time it reads the Run again.
      persistResolution: (attentionId, decision) => persistEvent({
        kind: 'attention-resolved',
        sequence: 0, // overwritten by persistEvent — see its own comment
        at: new Date().toISOString(),
        attentionId,
        decision: decision.kind === 'approve' ? 'approved' : decision.kind === 'deny' ? 'denied' : 'provided',
        ...(decision.kind === 'input' ? { input: decision.value } : {}),
      } satisfies AttemptAttentionResolvedEvent) as AttemptAttentionResolvedEvent,
      deliverDecision: (attentionId, decision) => {
        const resolve = attentionResolvers.get(attentionId);
        if (!resolve) return false;
        attentionResolvers.delete(attentionId);
        resolve(decision);
        return true;
      },
    });

    const context: AttemptLaunchContext = {
      runId: base.id,
      objective: base.spec.objective,
      acceptanceCriteria: base.spec.acceptanceCriteria,
      worktreePath: envelope.profile.writableWorktree,
      profile: envelope.profile,
      awaitAttentionDecision: (attentionId) => new Promise((resolve) => { attentionResolvers.set(attentionId, resolve); }),
    };

    try {
      for await (const event of adapter.run(context)) {
        persistEvent(event);
        if (event.kind === 'completion' || event.kind === 'failure') return;
      }
      // The adapter contract (adapter.contract.ts) requires exactly one
      // terminal event; an adapter that violates it still ends the Run in a
      // precise, recoverable failure rather than leaving it stuck running.
      persistSynthesizedFailure('The runtime adapter ended without reporting completion or failure.');
    } catch (error) {
      persistSynthesizedFailure(error instanceof Error ? error.message : String(error));
    } finally {
      this.liveAttempts.delete(base.id);
    }
  }

  /** See WorkEngine.resolveAttention's doc comment. */
  async resolveAttention(runId: string, attentionId: string, decision: AttentionDecisionInput): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const pending = existing.pendingAttention;
    if (!pending || pending.id !== attentionId) throw new RunAttentionNotPendingError(runId, attentionId);
    if (pending.kind === 'approval' && decision.kind === 'input') {
      throw new InvalidRunStateError('an approval request cannot be resolved by providing input');
    }
    if (pending.kind === 'input' && decision.kind !== 'input') {
      throw new InvalidRunStateError('an input request can only be resolved by providing input');
    }
    const live = this.liveAttempts.get(runId);
    // No live Attempt task in this process to hand the decision to — most
    // often because a restart already ended it via recover() (which always
    // runs before any caller can reach this engine), leaving no pending
    // request for a fresh read to find. This branch stays as defense in
    // depth for that invariant rather than something a normal caller can hit.
    if (!live) throw new RunAttentionNotPendingError(runId, attentionId);
    // Delivery is checked BEFORE the durable write, not after: the adapter
    // (codex.ts) always registers its resolver synchronously, in the same
    // turn it pushes the attention-requested event that makes this request
    // visible at all, so `deliverDecision` returning false here should
    // never happen in practice — but if that invariant were ever broken by
    // a future adapter, this refuses the decision instead of durably
    // recording a resolution nothing received, which would otherwise hang
    // the Attempt forever with no signal back to the caller.
    if (!live.deliverDecision(attentionId, decision)) throw new RunAttentionNotPendingError(runId, attentionId);
    live.persistResolution(attentionId, decision);
    return this.get(runId)!;
  }

  /** See WorkEngine.recover's doc comment. */
  async recover(): Promise<void> {
    const readiness = await this.runtimeReadiness.get();
    for (const run of this.store.listRuns()) {
      if (run.attempt.state !== 'running') continue;
      const attemptId = this.store.getAttemptId(run.id);
      // Cannot happen given attempt.state === 'running' (Store derives it
      // from this same attempts row) — guarded rather than asserted so a
      // future storage bug fails safe instead of throwing mid-boot.
      if (!attemptId) continue;
      const { runtime, events } = run.attempt;
      const reason = describeUnrecoverableAttempt(runtime, readiness, events);
      const failureEvent: AttemptEvent = {
        kind: 'failure', sequence: (events.at(-1)?.sequence ?? -1) + 1, at: new Date().toISOString(), reason,
      };
      this.store.appendAttemptEvent(buildAttemptEventEnvelope({ runId: run.id, attemptId, event: failureEvent }));
    }
  }
}
