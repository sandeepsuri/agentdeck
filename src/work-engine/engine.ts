import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import { createRuntimeReadinessSource, type RuntimeReadinessSource } from '../sessions/runtime-readiness.js';
import type { Store } from '../store/index.js';
import type { AgentType, Task } from '../types.js';
import { systemClock } from './clock.js';
import type { Clock, TimerHandle } from './clock.js';
import { buildCommitMessage, createLocalCommit } from './commit.js';
import { applyRunCommit, observeRunChanges } from './delivery.js';
import { buildAttemptEventEnvelope } from './durable-events.js';
import { buildRunEnvelope } from './envelope.js';
import { prepareRunWorktree, RunPreparationError } from './prepare.js';
import { resolveLocalPrincipal } from './principal.js';
import { decidePolicy } from './policy.js';
import type { PolicyAction } from './policy.js';
import {
  buildPullRequestInput, createGitRunPublisher,
} from './publication-git.js';
import {
  defaultPublicationTarget, executePublication, isPublicationTarget, redactSecrets,
} from './publication.js';
import type { RunPublisher } from './publication.js';
import { describeUnrecoverableAttempt } from './recovery.js';
import { findDeliveryCommit } from './run-result.js';
import { createClaudeAttemptAdapter } from './runtimes/claude.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import {
  buildRepairObjective, createShellVerificationGateRunner, freezeVerificationPolicy, MAX_VERIFICATION_REPAIR_ATTEMPTS,
} from './verification.js';
import type { FailingGateEvidence, VerificationGateRunner } from './verification.js';
import type { AttemptLaunchContext, RuntimeAttemptAdapter } from './runtimes/adapter.js';
import type {
  AttemptAttentionResolvedEvent, AttemptEvent, AttentionDecisionInput, CapabilityEnvelope, PublicationTarget, RunActivity,
  RunActivityKind, RunActor, RunPrincipal, RunPublication, WorkEngine, WorkRun, WorkSpec,
} from './types.js';

/**
 * Ticket 09 AC1/AC3/AC5: why one adapter round stopped short of a natural
 * completion/failure — either an operator's cancel() (no further evidence
 * needed; the raw 'cancelled' status already says why, exactly as it always
 * has) or the frozen budget.maxWallClockMs deadline firing (which does need
 * durable evidence — see AttemptBudgetExceededEvent). One shared promise per
 * Attempt carries whichever fires first to every in-flight round and to the
 * verification/repair loop, so both a live iterator.next() and a between-
 * rounds checkpoint learn about it exactly once.
 */
type AbortReason =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget-exceeded'; readonly configured: number; readonly observed: number };

/**
 * Builds the one durable event a budget-exceeded abort owes (AC1/AC3) —
 * shared so runAdapterRound and runVerification's own abort checkpoint
 * construct it identically. `sequence: 0` is a placeholder — persistEvent
 * always overwrites it (see its own comment).
 */
function buildBudgetExceededEvent(reason: Extract<AbortReason, { kind: 'budget-exceeded' }>): AttemptEvent {
  return {
    kind: 'budget-exceeded',
    sequence: 0,
    at: new Date().toISOString(),
    limit: 'maxWallClockMs',
    configured: reason.configured,
    observed: reason.observed,
  };
}

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

/** Ticket 12 AC1/AC4/AC7: policy.ts's decidePolicy() refused a RunActor's action — the one enforcement point every transport (REST, WebSocket, a direct engine call) shares. `rule` is decidePolicy's stable rule identifier (CONTEXT.md's Policy decision). */
export class PolicyDeniedError extends Error {
  constructor(public readonly rule: string, reason: string) {
    super(reason);
    this.name = 'PolicyDeniedError';
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
    && spec.requestedDeliveryResult !== 'apply-to-repository'
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

const TERMINAL_STATUSES: ReadonlySet<WorkRun['status']> = new Set([
  'completed', 'completed_unverified', 'failed_verification', 'failed_budget', 'failed', 'cancelled',
]);

/**
 * Ticket 09 AC4: the in-process half of pause/resume — a one-shot "should I
 * block right now" gate a live Attempt's safe-boundary check consults.
 * requestPause()/requestResume() only ever flip the flag and (if blocked)
 * release it; the *durable* pause-requested/paused/resumed events are always
 * persisted by the caller that knows the fact at the moment it becomes true
 * (pause()/resume() themselves for the request/resume; the safe-boundary
 * check itself for the moment it actually blocks) — exactly the same split
 * ticket 07's attentionResolvers/persistResolution already uses.
 */
class PauseGate {
  private requested = false;
  private release: (() => void) | undefined;

  requestPause(): void {
    this.requested = true;
  }

  requestResume(): void {
    this.requested = false;
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  get isRequested(): boolean {
    return this.requested;
  }

  /** Only ever called once isRequested is true; resolves once requestResume() is next called. */
  block(): Promise<void> {
    return new Promise((resolve) => { this.release = resolve; });
  }
}

/**
 * Ticket 09: the three pieces of one Attempt's safe-control state that only
 * ever travel and get consulted together (runVerification's
 * handleAbort/observeControls) — bundled into one value instead of three
 * parameters that would otherwise have to stay in sync by convention.
 */
interface AttemptControls {
  readonly abortSignal: Promise<AbortReason>;
  /** A synchronous mirror of `abortSignal` — see its construction in runAttempt for why a bare Promise can't answer "has this already fired". */
  getAbortReason(): AbortReason | undefined;
  readonly pauseGate: PauseGate;
}

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
    /** Ticket 09 AC5: aborts the currently in-flight adapter round (its process killed) — never affects an already-durable outcome. */
    triggerCancel(): void;
    /** Ticket 09 AC4: durably records the request and arms the pause gate; a live round keeps running until its next safe boundary. */
    requestPause(): void;
    /** Ticket 09 AC4: durably records the resume and releases the pause gate, whether or not it had actually blocked yet. */
    requestResume(): void;
  }>();

  /** Ticket 08: runs one verification gate's exact command — injected so tests can stand in a fast, deterministic fake instead of the real shell/timeout implementation. */
  private readonly verificationGateRunner: VerificationGateRunner;

  /** Ticket 09 AC7: the controllable clock every wall-clock budget check and timer reads — real time in production, a fake, manually-advanceable one in tests. */
  private readonly clock: Clock;

  /** Ticket 10 AC2: resolves the Principal recorded against each newly-submitted Run — injected so tests never depend on the actual OS user running them. */
  private readonly principalSource: () => RunPrincipal;

  /** Ticket 13: the port onto git/gh a publication executes through — the real one in production, a scripted one in tests. */
  private readonly publisher: RunPublisher;

  /**
   * Ticket 13 AC3: the one in-flight execution per Run, if any. A second
   * publish() for the same Run while one is executing joins this promise
   * instead of starting another — the durable intent already carries the
   * idempotency identity; this is only the in-process half that stops two
   * concurrent callers from both reaching the remote.
   */
  private readonly livePublications = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    runsRoot: string = path.join(defaultDataDir(), 'runs'),
    runtimeReadiness: RuntimeReadinessSource = createRuntimeReadinessSource(),
    runtimeAdapters: Partial<Record<AgentType, RuntimeAttemptAdapter>> = {
      codex: createCodexAttemptAdapter(),
      claude: createClaudeAttemptAdapter(),
    },
    verificationGateRunner: VerificationGateRunner = createShellVerificationGateRunner(),
    clock: Clock = systemClock,
    principalSource: () => RunPrincipal = resolveLocalPrincipal,
    publisher: RunPublisher = createGitRunPublisher(),
  ) {
    this.runsRoot = runsRoot;
    this.runtimeReadiness = runtimeReadiness;
    this.runtimeAdapters = runtimeAdapters;
    this.verificationGateRunner = verificationGateRunner;
    this.clock = clock;
    this.principalSource = principalSource;
    this.publisher = publisher;
  }

  /** Ticket 12: every mutating method's `actor?` param resolves through here — omitted means the engine's own principalSource, unrestricted (`grants` absent), exactly pre-ticket-12 behavior. */
  private resolveActor(actor?: RunActor): RunActor {
    return actor ?? { principal: this.principalSource() };
  }

  /** Ticket 12 AC1/AC4/AC7: the one enforcement point policy.ts's decidePolicy() reaches from every mutating method below — see PolicyDeniedError's own doc comment. */
  private enforcePolicy(actor: RunActor, action: PolicyAction): void {
    const decision = decidePolicy(actor, action);
    if (!decision.allowed) throw new PolicyDeniedError(decision.rule, decision.reason);
  }

  /** Ticket 12 AC2: appends one durable RunActivity row — never thrown on, since a failure to record attribution must not itself fail the action it's attributing. */
  private recordActivity(runId: string, kind: RunActivityKind, actor: RunActor): void {
    const activity: RunActivity = {
      id: randomUUID(), runId, kind, principal: actor.principal, at: new Date().toISOString(),
    };
    this.store.appendRunActivity(actor.device ? { ...activity, device: actor.device } : activity);
  }

  listActivity(runId: string): RunActivity[] {
    return this.store.listRunActivity(runId);
  }

  async submit(input: WorkSpec, actor?: RunActor): Promise<WorkRun> {
    const resolvedActor = this.resolveActor(actor);
    let input2 = input;
    if (resolvedActor.grants) {
      // AC1/AC4: a collaborator must name an admin-approved, granted
      // Profile — checked (and the runtime/budget/verification/delivery
      // fields overwritten from it, never trusted from the submitter's own
      // request) *before* validateWorkSpec below, so a collaborator's
      // placeholder values for those Profile-controlled fields can never
      // even reach validation, let alone the frozen spec.
      this.enforcePolicy(resolvedActor, {
        kind: 'submit', repositoryId: input.repository?.id ?? '', profileId: input.profileId,
      });
      const profile = this.store.getProfile(input.profileId!);
      if (!profile) throw new InvalidWorkSpecError(`no such Profile: ${input.profileId}`);
      // The Repository is resolved from the store by id for the same reason
      // the Profile-controlled fields above are: it is not the submitter's
      // to assert. A collaborator is never told a Repository's absolute path
      // (server/routes.ts's scopeRepos projects it away, and
      // server/collaborator-run-view.ts drops it from every Run), so they
      // could not supply a matching one even in good faith -- and the
      // known-Repository check below would reject the request. Resolving it
      // here means the frozen spec still names the real Repository, without
      // that path ever having made a round trip through a device.
      const repository = this.store.listRepos().find((known) => known.id === input.repository?.id);
      if (!repository) throw new InvalidWorkSpecError('repository is not known to AgentDeck');
      input2 = {
        ...input,
        repository: { id: repository.id, name: repository.name, path: repository.path },
        runtimePreference: [...profile.runtimePreference],
        budget: { ...profile.budget },
        verificationIntent: { ...profile.verificationIntent, commands: [...profile.verificationIntent.commands] },
        requestedDeliveryResult: profile.requestedDeliveryResult,
        profileId: profile.id,
      };
    }
    validateWorkSpec(input2);
    const knownRepository = this.store.listRepos().find((repository) => repository.id === input2.repository.id);
    if (!knownRepository || knownRepository.path !== input2.repository.path
      || knownRepository.name !== input2.repository.name) {
      throw new InvalidWorkSpecError('repository is not known to AgentDeck');
    }
    const spec = frozenCopy(input2);
    const taskId = randomUUID();
    const run = frozenCopy<WorkRun>({
      id: randomUUID(),
      taskId,
      status: 'queued',
      spec,
      submittedAt: new Date().toISOString(),
      principal: resolvedActor.principal,
      preparation: { state: 'pending' },
      envelope: { state: 'pending' },
      verificationPolicy: { state: 'pending' },
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
    this.recordActivity(run.id, 'submitted', resolvedActor);
    return run;
  }

  get(runId: string): WorkRun | undefined {
    const run = this.store.getRun(runId);
    return run ? frozenCopy(run) : undefined;
  }

  list(): WorkRun[] {
    return this.store.listRuns().map(frozenCopy);
  }

  async prepare(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    this.enforcePolicy(this.resolveActor(actor), { kind: 'guide', repositoryId: existing.spec.repository.id });
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new InvalidRunStateError(`cannot prepare a Run in terminal status: ${existing.status}`);
    }
    // Ready worktrees are never recreated (their path/branch would collide
    // with themselves) — a repeated call, e.g. after a restart, is a no-op.
    if (existing.preparation.state === 'ready') return frozenCopy(existing);

    const repositoryVerificationPolicy = this.store.getRepositoryVerificationPolicy(existing.spec.repository.id);
    if (!repositoryVerificationPolicy) {
      const error = 'No verification policy is configured for this Repository. Configure required gates or explicitly allow unverified work before starting the Run.';
      this.store.updateRun(frozenCopy<WorkRun>({
        ...existing, status: 'preparing', preparation: { state: 'failed', error },
      }));
      throw new RunPreparationError(error);
    }

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
        budget: existing.spec.budget,
      });
      // Ticket 08 AC1/AC2: freeze the Repository's admin-approved
      // verification policy at the same instant — resolved once, from
      // AgentDeck's own store, never the Repository's working tree. A later
      // change to the approved policy (an admin edit, or a hostile one)
      // never reaches this already-frozen Run again.
      const verificationPolicy = freezeVerificationPolicy(
        repositoryVerificationPolicy,
      );
      const ready = frozenCopy<WorkRun>({
        ...existing, status: 'preparing', preparation: { state: 'ready', ...prepared }, envelope, verificationPolicy,
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

  async cancel(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
    // Cancellation never touches a prepared worktree, its durable events, or
    // any result already produced — it is only a status change (plus, per
    // ticket 09 AC5 below, stopping a still-live process), and stays that
    // way regardless of what preparation recorded.
    if (TERMINAL_STATUSES.has(existing.status)) return frozenCopy(existing);
    const cancelled = frozenCopy<WorkRun>({ ...existing, status: 'cancelled' });
    this.store.updateRun(cancelled);
    // Ticket 09 AC5: if this Attempt is still live in this process, stop its
    // runtime authority now rather than letting it run to a natural
    // completion — see runAdapterRound's abort race. A no-op when nothing is
    // live (already terminal, or a different process instance), exactly
    // like resolveAttention's own liveAttempts lookup.
    this.liveAttempts.get(runId)?.triggerCancel();
    this.recordActivity(runId, 'cancelled', resolvedActor);
    return cancelled;
  }

  /** See WorkEngine.pause's doc comment. */
  async pause(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
    if (existing.status === 'pause_requested' || existing.status === 'paused') return frozenCopy(existing);
    if (existing.attempt.state !== 'running') {
      throw new InvalidRunStateError(`cannot pause a Run whose Attempt is not running (${existing.status})`);
    }
    const live = this.liveAttempts.get(runId);
    // Mirrors resolveAttention: no live task in this process (most often a
    // restart already ended it via recover()) means there is nothing left
    // to ask to pause.
    if (!live) throw new InvalidRunStateError('no live Attempt is running for this Run in this process');
    live.requestPause();
    this.recordActivity(runId, 'paused', resolvedActor);
    return this.get(runId)!;
  }

  /** See WorkEngine.resume's doc comment. */
  async resume(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
    if (existing.status !== 'pause_requested' && existing.status !== 'paused') {
      throw new InvalidRunStateError(`cannot resume a Run that is not paused (${existing.status})`);
    }
    const live = this.liveAttempts.get(runId);
    if (!live) throw new InvalidRunStateError('no live Attempt is running for this Run in this process');
    live.requestResume();
    this.recordActivity(runId, 'resumed', resolvedActor);
    return this.get(runId)!;
  }

  async start(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    this.enforcePolicy(this.resolveActor(actor), { kind: 'guide', repositoryId: existing.spec.repository.id });
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
    // `dedupeScope` defaults to `attemptId` in buildAttemptEventEnvelope —
    // exactly ticket 06/07's original behavior for this Attempt's one
    // adapter invocation. Ticket 08's repair rounds and verification passes
    // pass their own scope (see runAdapterRound/runVerification) so a
    // structurally-identical event from a *different* round or pass (a
    // repeated 'attempt-started', or a gate that fails with the same
    // evidence twice) is never mistaken for the same provider notification
    // redelivered and silently dropped.
    const persistEvent = (event: AttemptEvent, dedupeScope?: string): AttemptEvent => {
      const sequenced = { ...event, sequence: lastSequence + 1 };
      lastSequence = sequenced.sequence;
      const eventEnvelope = buildAttemptEventEnvelope({
        runId: base.id, attemptId, event: sequenced, dedupeScope,
      });
      // No AttemptEvent kind is transient today (durable-events.ts) — this
      // guard is where a future message-delta or raw-output kind would be
      // dropped rather than persisted as source-of-truth history (ticket 06
      // AC3), so it stays even though it can never trigger yet.
      if (eventEnvelope.durability === 'durable') this.store.appendAttemptEvent(eventEnvelope);
      return sequenced;
    };

    // Ticket 07: registered before the adapter ever runs so a decision made
    // the instant an attention-requested event lands can never race ahead of
    // this map having an entry for it.
    const attentionResolvers = new Map<string, (decision: AttentionDecisionInput) => void>();

    // Ticket 09 AC5: one abort signal for this Attempt's whole lifetime —
    // resolved at most once, either by cancel() (triggerCancel) or by the
    // wall-clock deadline below, whichever fires first. Raced against every
    // in-flight adapter round's own iterator.next() (runAdapterRound) so a
    // runtime that is silently hanging, producing no events at all, can
    // still be stopped rather than only ever checked between rounds.
    let resolveAbort!: (reason: AbortReason) => void;
    let abortReason: AbortReason | undefined;
    const abortSignal = new Promise<AbortReason>((resolve) => { resolveAbort = resolve; });
    // A plain, synchronously-readable mirror of abortSignal — the
    // verification/repair loop's between-round checkpoints (runVerification)
    // need to ask "has this already fired" without an `await`, which a bare
    // Promise can't answer.
    void abortSignal.then((reason) => { abortReason = reason; });

    // Ticket 09 AC1/AC3: the frozen wall-clock budget, enforced for real —
    // scheduled once, for this Attempt's whole lifetime (initial round
    // through every repair round and verification pass), on the injected
    // clock so a test can fire it deterministically (AC7) instead of
    // actually waiting.
    const maxWallClockMs = base.spec.budget.maxWallClockMs;
    const attemptStartMs = this.clock.now();
    const wallClockTimer = maxWallClockMs === undefined ? undefined : this.clock.setTimeout(() => {
      resolveAbort({
        kind: 'budget-exceeded', configured: maxWallClockMs, observed: this.clock.now() - attemptStartMs,
      });
    }, maxWallClockMs);

    const pauseGate = new PauseGate();

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
      triggerCancel: () => resolveAbort({ kind: 'cancelled' }),
      requestPause: () => {
        persistEvent({ kind: 'pause-requested', sequence: 0, at: new Date().toISOString() });
        pauseGate.requestPause();
      },
      requestResume: () => {
        persistEvent({ kind: 'resumed', sequence: 0, at: new Date().toISOString() });
        pauseGate.requestResume();
      },
    });

    const context: AttemptLaunchContext = {
      runId: base.id,
      objective: base.spec.objective,
      acceptanceCriteria: base.spec.acceptanceCriteria,
      worktreePath: envelope.profile.writableWorktree,
      profile: envelope.profile,
      awaitAttentionDecision: (attentionId) => new Promise((resolve) => { attentionResolvers.set(attentionId, resolve); }),
      // Ticket 09: the same signal every round (initial and each repair —
      // repairContext spreads this same context, see runVerification) races
      // against in runAdapterRound, handed to the adapter itself so it can
      // stop its own real process directly. See its own doc comment.
      abortRequested: abortSignal.then(() => undefined),
    };

    try {
      const outcome = await this.runAdapterRound(adapter, context, persistEvent, abortSignal);
      // Ticket 08: a plain runtime failure never goes through verification —
      // it already ended the Run in 'failed' (AC6's "distinct from a
      // runtime failure"). Only a real completion earns a verification pass.
      // Ticket 09: an aborted initial round ('cancelled'/'budget-exceeded')
      // is already fully handled by runAdapterRound (nothing persisted for
      // 'cancelled' — the raw status already says why; a durable
      // 'budget-exceeded' event for the other) — there is nothing left to
      // verify either way.
      if (outcome === 'completion') {
        const controls: AttemptControls = { abortSignal, getAbortReason: () => abortReason, pauseGate };
        await this.runVerification(base, adapter, context, envelope, persistEvent, controls);
      }
    } finally {
      if (wallClockTimer !== undefined) this.clock.clearTimeout(wallClockTimer);
      this.liveAttempts.delete(base.id);
    }
  }

  /**
   * Runs one adapter invocation to its own terminal event — the initial
   * Attempt round, or (ticket 08) one repair round handed a fresh, evidence-
   * carrying `context.objective` — appending every event it yields through
   * `persistEvent` unchanged. An adapter that violates its own contract
   * (ends with no terminal event) or throws still ends the round in a
   * precise, recoverable failure rather than leaving it stuck running.
   *
   * Ticket 09 AC5/AC1: each pulled event races against `abortSignal`, so a
   * round that is silently hanging — no event, ever — still notices an
   * abort rather than blocking this loop forever. Stopping the real
   * process itself is the adapter's own job, not this loop's: an async
   * generator's `.return()` only interrupts a *cleanly suspended* generator
   * (at a yield, with no `.next()` already in flight) — once a `.next()`
   * call is outstanding, as it always is here mid-race, `.return()` simply
   * queues behind it and never fires if that call never settles (verified
   * empirically; a hung `.next()` makes `.return()` hang too). So this loop
   * never awaits `.return()` for cleanup — it hands `context.abortRequested`
   * to the adapter up front (see runAttempt), which is what actually kills
   * the process, independent of wherever the generator happens to be
   * suspended.
   */
  private async runAdapterRound(
    adapter: RuntimeAttemptAdapter,
    context: AttemptLaunchContext,
    persistEvent: (event: AttemptEvent, dedupeScope?: string) => AttemptEvent,
    abortSignal: Promise<AbortReason>,
    // Ticket 08: distinguishes a repair round's events (its own
    // 'attempt-started', etc.) from the initial round's structurally
    // identical ones — see persistEvent's own comment. undefined for the
    // initial round preserves ticket 06/07's original dedupe scope exactly.
    dedupeScope?: string,
  ): Promise<'completion' | 'failure' | 'cancelled' | 'budget-exceeded'> {
    const persistSynthesizedFailure = (reason: string): void => {
      persistEvent({
        kind: 'failure', sequence: 0, at: new Date().toISOString(), reason,
      }, dedupeScope);
    };
    const iterator = adapter.run(context)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await Promise.race([
          iterator.next().then((result) => ({ kind: 'next' as const, result })),
          abortSignal.then((reason) => ({ kind: 'abort' as const, reason })),
        ]);
        if (step.kind === 'abort') {
          // Never awaited (see this method's own doc comment) — a
          // best-effort courtesy for an adapter that happens to be cleanly
          // suspended, not the mechanism that actually stops anything.
          void iterator.return?.().catch(() => undefined);
          if (step.reason.kind === 'cancelled') return 'cancelled';
          persistEvent(buildBudgetExceededEvent(step.reason), dedupeScope);
          return 'budget-exceeded';
        }
        if (step.result.done) {
          persistSynthesizedFailure('The runtime adapter ended without reporting completion or failure.');
          return 'failure';
        }
        persistEvent(step.result.value, dedupeScope);
        if (step.result.value.kind === 'completion') return 'completion';
        if (step.result.value.kind === 'failure') return 'failure';
      }
    } catch (error) {
      persistSynthesizedFailure(error instanceof Error ? error.message : String(error));
      return 'failure';
    }
  }

  /**
   * Ticket 08: runs the Run's frozen required gates (plus, unconditionally,
   * any supplemental checks the requester selected — AC3, never a
   * replacement for a required gate) against the Attempt's completed work,
   * with a bounded repair cycle (ticket 09: `budget.maxRepairAttempts`, or
   * MAX_VERIFICATION_REPAIR_ATTEMPTS when unset) for a runtime that leaves
   * any gate failing. Always ends by persisting exactly one
   * 'verification-outcome' event, except:
   * - a cancellation observed between rounds — the Run is left exactly as
   *   it is, so deriveRunStatus (attempt-projection.ts) surfaces the
   *   cancellation instead of a fabricated outcome (ticket 08, unchanged);
   * - a wall-clock budget observed between rounds (ticket 09) — a durable
   *   'budget-exceeded' event is persisted instead, and RunStatus surfaces
   *   'failed_budget'.
   *
   * Ticket 09 AC4: also honors a pause request at the same "between rounds"
   * safe boundary — persists 'paused' and blocks until resumed before
   * starting the next gate-checking pass or repair round.
   */
  private async runVerification(
    base: WorkRun,
    adapter: RuntimeAttemptAdapter,
    context: AttemptLaunchContext,
    envelope: CapabilityEnvelope,
    persistEvent: (event: AttemptEvent, dedupeScope?: string) => AttemptEvent,
    controls: AttemptControls,
  ): Promise<void> {
    const now = (): string => new Date().toISOString();
    // Persists the durable evidence a hard-limit abort owes (AC1/AC3) —
    // cancellation needs none of its own; the raw 'cancelled' status already
    // says why (unchanged from ticket 08).
    const handleAbort = (): boolean => {
      const reason = controls.getAbortReason();
      if (!reason) return false;
      if (reason.kind === 'budget-exceeded') persistEvent(buildBudgetExceededEvent(reason));
      return true;
    };
    // The one safe-boundary checkpoint: has this Attempt been asked to stop
    // (cancelled/budget-exceeded), or to pause? The block is raced against
    // abortSignal, not merely awaited — a cancellation or a wall-clock
    // deadline reached while paused must still be able to end the Attempt
    // rather than wait forever for a resume() that may never come; the
    // trailing handleAbort() catches that case (pauseGate.block() itself
    // never settles then, but nothing needs it to).
    const observeControls = async (): Promise<boolean> => {
      if (handleAbort()) return true;
      if (controls.pauseGate.isRequested) {
        persistEvent({ kind: 'paused', sequence: 0, at: now() });
        await Promise.race([controls.pauseGate.block(), controls.abortSignal]);
        if (handleAbort()) return true;
      }
      return false;
    };
    const policy = base.verificationPolicy;

    const snapshotChanges = async (scope: string): Promise<void> => {
      try {
        persistEvent({
          kind: 'worktree-changes', sequence: 0, at: now(),
          changedFiles: await observeRunChanges(envelope.profile.writableWorktree),
        }, scope);
      } catch {
        // A missing/corrupt worktree is reported by the verification or
        // delivery operation itself. A snapshot is evidence, not authority
        // to replace the terminal outcome with a different failure.
      }
    };
    await snapshotChanges('changes-initial');

    if (policy.state === 'missing') {
      // AC8: never silently treated as success — a Repository with no
      // approved policy at all cannot reach a verified outcome.
      persistEvent({
        kind: 'verification-outcome', sequence: 0, at: now(), outcome: 'failed_verification', repairAttempts: 0,
      });
      return;
    }
    if (policy.state === 'declared-unverified') {
      // An explicit admin-approved no-verification policy is still allowed
      // to deliver the requested local artifact; the Run remains honestly
      // labelled completed_unverified and can never be published as verified.
      await this.deliverLocalCommit(base, envelope, persistEvent);
      persistEvent({
        kind: 'verification-outcome', sequence: 0, at: now(), outcome: 'unverified', repairAttempts: 0,
      });
      return;
    }
    // 'pending' cannot happen here: start() only ever begins an Attempt once
    // preparation is 'ready', which freezes verificationPolicy in the same
    // step (see prepare()) — left as a documented no-op rather than an
    // assertion so a future storage bug fails safe instead of throwing
    // mid-Attempt.
    if (policy.state !== 'ready') return;

    const gates: readonly { gate: { name: string; command: string }; required: boolean }[] = [
      ...policy.requiredGates.map((gate) => ({ gate, required: true as const })),
      ...base.spec.verificationIntent.commands.map((command) => ({
        gate: { name: command, command }, required: base.spec.verificationIntent.required,
      })),
    ];
    // Ticket 09 AC1: the "Attempt count" / "repair cycles" hard limit —
    // configurable per Run, defaulting to ticket 08's original constant.
    const maxRepairAttempts = base.spec.budget.maxRepairAttempts ?? MAX_VERIFICATION_REPAIR_ATTEMPTS;

    let repairAttempts = 0;
    for (;;) {
      if (await observeControls()) return;
      if (repairAttempts > 0) await snapshotChanges(`changes-verify-${repairAttempts}`);

      // Ticket 08: each verification pass gets its own dedupe scope — a gate
      // that fails with byte-identical evidence on this pass and the last
      // one is a distinct, newly-observed fact, not the same event
      // redelivered (see persistEvent's own comment).
      const passScope = `verify-${repairAttempts}`;
      const failing: FailingGateEvidence[] = [];
      // Gates run sequentially, in the order the frozen policy lists them,
      // so evidence stays deterministic run to run.
      for (const { gate, required } of gates) {
        // A hard-limit abort mid-pass stops the next gate from starting —
        // bounded by at most one gate's own runtime, not the whole pass.
        if (handleAbort()) return;
        const result = await this.verificationGateRunner(gate, envelope.profile.writableWorktree);
        persistEvent({
          kind: 'verification-check',
          sequence: 0,
          at: now(),
          gate: gate.name,
          command: gate.command,
          required,
          passed: result.passed,
          exitCode: result.exitCode,
          evidence: result.evidence,
        }, passScope);
        if (!result.passed && required) failing.push({ gate, required, result });
      }

      if (failing.length === 0) {
        await this.deliverLocalCommit(base, envelope, persistEvent);
        persistEvent({
          kind: 'verification-outcome', sequence: 0, at: now(), outcome: 'verified', repairAttempts,
        });
        return;
      }
      if (await observeControls()) return;
      if (repairAttempts >= maxRepairAttempts) {
        persistEvent({
          kind: 'verification-outcome', sequence: 0, at: now(), outcome: 'failed_verification', repairAttempts,
        });
        return;
      }

      repairAttempts += 1;
      const repairContext: AttemptLaunchContext = {
        ...context,
        objective: buildRepairObjective(base.spec.objective, failing),
      };
      // Each repair round must finish (and its gates re-checked) before
      // deciding on the next one. Its own scope (see runAdapterRound's own
      // comment) keeps its 'attempt-started' event from colliding with an
      // earlier round's structurally-identical one.
      const outcome = await this.runAdapterRound(
        adapter, repairContext, persistEvent, controls.abortSignal, `repair-${repairAttempts}`,
      );
      // A repair round that itself fails is a runtime failure, not a
      // verification failure (AC6) — runAdapterRound already persisted the
      // terminal 'failure' event, so there is nothing left to conclude here.
      // A cancelled/budget-exceeded round is likewise already fully handled
      // by runAdapterRound (ticket 09).
      if (outcome !== 'completion') return;
    }
  }

  /**
   * Ticket 10 AC1/AC6: only ever reached once verification has already
   * passed — never for any other outcome (AC7 preserves the worktree and
   * reports an honest non-success result instead, with no commit attempted
   * at all). Creates a local commit with AgentDeck's own identity when the
   * requester actually wants one delivered (requestedDeliveryResult
   * 'local-commit', 'apply-to-repository', or 'pull-request' — a later ticket's publish step still
   * needs a local commit to push from; only 'working-tree' skips this
   * entirely). Never pushes, never opens a pull request itself (AC6). A
   * durable 'commit-created' or 'commit-failed' event records how it went —
   * delivery failing never retroactively changes the Run's own verified
   * status, which already settled by the time this runs.
   */
  private async deliverLocalCommit(
    base: WorkRun,
    envelope: CapabilityEnvelope,
    persistEvent: (event: AttemptEvent, dedupeScope?: string) => AttemptEvent,
  ): Promise<void> {
    if (base.spec.requestedDeliveryResult === 'working-tree') return;
    const message = buildCommitMessage(base.spec.objective, base.id, base.principal);
    const result = await createLocalCommit(envelope.profile.writableWorktree, message);
    if (result.kind === 'committed') {
      persistEvent({
        kind: 'commit-created',
        sequence: 0,
        at: new Date().toISOString(),
        sha: result.sha,
        branch: result.branch,
        signed: result.signed,
        changedFiles: result.changedFiles,
      });
      if (base.spec.requestedDeliveryResult === 'apply-to-repository') {
        const applied = await applyRunCommit({
          repositoryPath: base.spec.repository.path,
          targetBranch: base.preparation.state === 'ready' ? base.preparation.targetBranch : undefined,
          expectedBaseCommit: base.preparation.state === 'ready' ? base.preparation.baseCommit! : '',
          commit: result.sha,
        });
        persistEvent({
          kind: 'delivery-outcome', sequence: 0, at: new Date().toISOString(), outcome: applied.kind,
          ...(applied.kind === 'applied'
            ? { repositoryPath: applied.repositoryPath, branch: applied.branch }
            : { reason: applied.reason }),
        });
      }
    } else if (result.kind === 'failed') {
      persistEvent({ kind: 'commit-failed', sequence: 0, at: new Date().toISOString(), reason: result.reason });
    }
  }

  /** Appends recovery/delivery evidence after an Attempt has already settled. */
  private settledEventAppender(run: WorkRun, scope: string): (event: AttemptEvent) => AttemptEvent {
    const attemptId = this.store.getAttemptId(run.id);
    if (!attemptId || run.attempt.state === 'idle') throw new InvalidRunStateError('this Run has no Attempt event log');
    let sequence = run.attempt.events.at(-1)?.sequence ?? -1;
    return (event) => {
      const sequenced = { ...event, sequence: ++sequence } as AttemptEvent;
      const envelope = buildAttemptEventEnvelope({ runId: run.id, attemptId, event: sequenced, dedupeScope: scope });
      this.store.appendAttemptEvent(envelope);
      return sequenced;
    };
  }

  async reverify(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
    if (existing.status !== 'failed_verification' || existing.attempt.state !== 'completed') {
      throw new InvalidRunStateError('only a Run that failed verification can retry verification');
    }
    if (existing.preparation.state !== 'ready' || existing.envelope.state !== 'ready') {
      throw new InvalidRunStateError('this Run has no prepared worktree to verify');
    }
    const configuredPolicy = this.store.getRepositoryVerificationPolicy(existing.spec.repository.id);
    // Legacy Runs could finish before submission-time policy configuration
    // existed. An explicit local recovery action may adopt that frozen Run's
    // own intent once, without rerunning the runtime or changing the
    // Repository-wide policy behind the operator's back.
    const recoveryPolicy = configuredPolicy ?? (existing.spec.verificationIntent.required
      ? {
        kind: 'required' as const,
        gates: existing.spec.verificationIntent.commands.map((command) => ({ name: command, command })),
      }
      : { kind: 'no-verification' as const });
    const policy = freezeVerificationPolicy(recoveryPolicy);
    if (policy.state === 'missing' || policy.state === 'pending') throw new InvalidRunStateError('no verification policy is available');
    const updated = frozenCopy<WorkRun>({ ...existing, verificationPolicy: policy });
    this.store.updateRun(updated);
    const persistEvent = this.settledEventAppender(updated, `reverify-${randomUUID()}`);
    try {
      persistEvent({
        kind: 'worktree-changes', sequence: 0, at: new Date().toISOString(),
        changedFiles: await observeRunChanges(existing.preparation.worktreePath!),
      });
    } catch { /* gate evidence below remains authoritative */ }

    if (policy.state === 'declared-unverified') {
      await this.deliverLocalCommit(updated, existing.envelope.capabilityEnvelope, persistEvent);
      persistEvent({ kind: 'verification-outcome', sequence: 0, at: new Date().toISOString(), outcome: 'unverified', repairAttempts: 0 });
    } else {
      const gates = [
        ...policy.requiredGates.map((gate) => ({ gate, required: true })),
        ...(configuredPolicy ? existing.spec.verificationIntent.commands : []).map((command) => ({
          gate: { name: command, command }, required: existing.spec.verificationIntent.required,
        })),
      ];
      let requiredFailure = false;
      for (const { gate, required } of gates) {
        const result = await this.verificationGateRunner(gate, existing.preparation.worktreePath!);
        persistEvent({
          kind: 'verification-check', sequence: 0, at: new Date().toISOString(), gate: gate.name,
          command: gate.command, required, passed: result.passed, exitCode: result.exitCode, evidence: result.evidence,
        });
        if (required && !result.passed) requiredFailure = true;
      }
      if (requiredFailure) {
        persistEvent({ kind: 'verification-outcome', sequence: 0, at: new Date().toISOString(), outcome: 'failed_verification', repairAttempts: 0 });
      } else {
        await this.deliverLocalCommit(updated, existing.envelope.capabilityEnvelope, persistEvent);
        persistEvent({ kind: 'verification-outcome', sequence: 0, at: new Date().toISOString(), outcome: 'verified', repairAttempts: 0 });
      }
    }
    this.recordActivity(runId, 'verification-retried', resolvedActor);
    return this.get(runId)!;
  }

  async apply(runId: string, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
    if (existing.attempt.state !== 'completed' || existing.preparation.state !== 'ready') {
      throw new InvalidRunStateError('this Run has no completed result to apply');
    }
    const commit = findDeliveryCommit(existing);
    if (!commit) throw new InvalidRunStateError('this Run produced no local commit to apply');
    const previous = [...existing.attempt.events].reverse().find((event) => event.kind === 'delivery-outcome');
    if (previous?.kind === 'delivery-outcome' && previous.outcome === 'applied') return frozenCopy(existing);

    const result = await applyRunCommit({
      repositoryPath: existing.spec.repository.path,
      targetBranch: existing.preparation.targetBranch,
      expectedBaseCommit: existing.preparation.baseCommit!,
      commit: commit.sha,
    });
    const persistEvent = this.settledEventAppender(existing, `apply-${randomUUID()}`);
    persistEvent({
      kind: 'delivery-outcome', sequence: 0, at: new Date().toISOString(), outcome: result.kind,
      ...(result.kind === 'applied'
        ? { repositoryPath: result.repositoryPath, branch: result.branch }
        : { reason: result.reason }),
    });
    this.recordActivity(runId, 'delivery-requested', resolvedActor);
    return this.get(runId)!;
  }

  /** See WorkEngine.resolveAttention's doc comment. */
  async resolveAttention(runId: string, attentionId: string, decision: AttentionDecisionInput, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'guide', repositoryId: existing.spec.repository.id });
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
    this.recordActivity(runId, decision.kind === 'approve' ? 'approved' : decision.kind === 'deny' ? 'denied' : 'input', resolvedActor);
    return this.get(runId)!;
  }

  /** See WorkEngine.remove's doc comment. */
  async remove(runId: string, actor?: RunActor): Promise<void> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    this.enforcePolicy(resolvedActor, { kind: 'delete', repositoryId: existing.spec.repository.id });
    if (!TERMINAL_STATUSES.has(existing.status)) {
      throw new InvalidRunStateError(`cannot delete a Run that is still in progress: ${existing.status}`);
    }
    this.store.deleteRun(runId);
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
    // Ticket 13 AC5: an intent the admin authorized but that never reached
    // a settled state before the previous process stopped is resumed — the
    // authorization is durable, so completing it needs no new decision —
    // and resuming always begins by observing origin (executePublication),
    // never by re-sending anything origin already has. An intent found
    // 'executing' may have sent a command already, so an unobservable
    // remote makes it 'ambiguous' (AC6) rather than a plain failure. Fire-
    // and-forget, exactly like start(): a push against a slow network must
    // not hold boot; progress is observed by rereading the Run.
    for (const intent of this.store.listIncompleteRunPublications()) {
      const run = this.store.getRun(intent.runId);
      if (!run) continue;
      void this.runPublication(run, intent, intent.state === 'executing');
    }
  }

  /** See WorkEngine.publish's doc comment. */
  async publish(runId: string, input: { target?: PublicationTarget } = {}, actor?: RunActor): Promise<WorkRun> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new RunNotFoundError(runId);
    const resolvedActor = this.resolveActor(actor);
    // AC2: refused for every collaborator actor before anything else is
    // even inspected — the same decidePolicy() every transport reaches.
    this.enforcePolicy(resolvedActor, { kind: 'publish', repositoryId: existing.spec.repository.id });
    if (input.target !== undefined && !isPublicationTarget(input.target)) {
      throw new InvalidRunStateError('publication target must be push or draft-pull-request');
    }
    // AC1/AC2: only an ordinarily successful, verified Run ('completed' —
    // never 'completed_unverified' or any failure) that actually delivered
    // a local commit has anything to publish.
    if (existing.status !== 'completed') {
      throw new InvalidRunStateError(`only a verified, completed Run can be published (${existing.status})`);
    }
    const commit = findDeliveryCommit(existing);
    if (!commit) throw new InvalidRunStateError('this Run produced no local commit to publish');
    if (existing.preparation.state !== 'ready' || !existing.preparation.worktreePath) {
      throw new InvalidRunStateError('this Run has no prepared worktree to publish from');
    }
    const target: PublicationTarget = input.target ?? defaultPublicationTarget(existing.spec.requestedDeliveryResult);

    let intent = existing.publication;
    // Captured before `intent` is possibly reassigned below — the flag
    // executePublication needs (an unobservable remote before anything is
    // sent this call is 'ambiguous' rather than 'failed' only if an
    // earlier execution, under either target, may already have acted) has
    // to reflect what this Run's history actually shows, not the freshly
    // re-authorized 'authorized' state a re-target lands on.
    const priorState = intent?.state;

    if (intent && intent.target !== target) {
      // AC3's "stable idempotency identity" is per Run + commit, not per
      // (Run, target) — one durable row per Run either way (run_publications'
      // run_id is UNIQUE). Re-authorizing a different target is refused only
      // while the existing intent's outcome is still unsettled: 'executing'
      // (a command may be in flight right now) or 'ambiguous' (AC6 — the
      // admin must reconcile it, which means retrying the SAME target, before
      // asking for a different one). A 'failed' intent is a proven no-op —
      // nothing to reconcile — and a 'succeeded' one (e.g. a plain push) can
      // still be legitimately re-authorized to additionally open a pull
      // request; executePublication's own reconcile-first discipline handles
      // either resulting combination correctly without any special-casing
      // here.
      if (intent.state === 'executing') {
        throw new InvalidRunStateError('this Run\'s publication is currently executing; wait for it to settle before changing the target');
      }
      if (intent.state === 'ambiguous') {
        throw new InvalidRunStateError(`this Run's ${intent.target} publication is ambiguous; reconcile it before authorizing a different target`);
      }
      const now = new Date().toISOString();
      intent = {
        ...intent, target, state: 'authorized', authorizedBy: resolvedActor.principal, authorizedAt: now, updatedAt: now, executions: 0,
      };
      delete (intent as { result?: unknown }).result;
      delete (intent as { reason?: unknown }).reason;
      this.store.updateRunPublication(intent);
      this.recordActivity(runId, 'publish-authorized', resolvedActor);
    } else if (intent) {
      // AC3: the same Run + commit + target is the same intent — a
      // repeated command resumes or returns it, never records a second
      // authorization.
      if (intent.state === 'succeeded') return this.get(runId)!;
    } else {
      const now = new Date().toISOString();
      intent = {
        id: randomUUID(),
        runId,
        idempotencyKey: `run:${runId}:commit:${commit.sha}`,
        target,
        commit: commit.sha,
        branch: commit.branch,
        state: 'authorized',
        authorizedBy: resolvedActor.principal,
        authorizedAt: now,
        updatedAt: now,
        executions: 0,
      };
      // Durable before any command runs (AC3) — and attributed (AC4) — so
      // a crash between here and the push can never lose "this was
      // authorized and may have started".
      this.store.createRunPublication(intent);
      this.recordActivity(runId, 'publish-authorized', resolvedActor);
    }
    // A prior execution may have already sent something only if it was
    // interrupted mid-flight ('executing' with no live task — a restart
    // that raced this call), already judged ambiguous, or already
    // succeeded (a re-target building on a confirmed earlier effect);
    // 'authorized' never sent anything and 'failed' is a proven no-op, so a
    // retry of either starts clean.
    const priorExecution = priorState === 'executing' || priorState === 'ambiguous' || priorState === 'succeeded';
    await this.runPublication(existing, intent, priorExecution);
    return this.get(runId)!;
  }

  /**
   * One execution of a durable publication intent, shared by publish() and
   * recover(): marks it 'executing' (with the execution count bumped and
   * any earlier result/reason cleared), runs executePublication against
   * the Run's own prepared worktree — never the Repository it came from
   * (ticket 03's boundary) — and persists exactly the settled outcome it
   * reports. Any unexpected throw is recorded as 'ambiguous' rather than
   * left 'executing' forever: an unknown error mid-external-effect is, by
   * definition, an outcome that cannot be proven either way (AC6).
   */
  private runPublication(run: WorkRun, intent: RunPublication, priorExecution: boolean): Promise<void> {
    const live = this.livePublications.get(run.id);
    if (live) return live;
    const worktreePath = run.preparation.worktreePath;
    // No prepared worktree to publish from is not survivable — settle the
    // intent as failed rather than leaving it 'authorized'/'executing'
    // forever (which listIncompleteRunPublications would otherwise re-pick
    // every boot with no admin action able to move it).
    if (!worktreePath) {
      const failed: RunPublication = {
        ...intent, state: 'failed', reason: 'This Run has no prepared worktree to publish from.', updatedAt: new Date().toISOString(),
      };
      this.store.updateRunPublication(failed);
      return Promise.resolve();
    }
    const task = (async () => {
      const executing: RunPublication = {
        ...intent, state: 'executing', executions: intent.executions + 1, updatedAt: new Date().toISOString(),
      };
      delete (executing as { result?: unknown }).result;
      delete (executing as { reason?: unknown }).reason;
      let settled: RunPublication;
      try {
        this.store.updateRunPublication(executing);
        const outcome = await executePublication(
          this.publisher, executing, { worktreePath, pullRequest: buildPullRequestInput(run, executing) }, { priorExecution },
        );
        settled = outcome.state === 'succeeded'
          ? { ...executing, state: 'succeeded', result: outcome.result, updatedAt: new Date().toISOString() }
          : { ...executing, state: outcome.state, reason: outcome.reason, updatedAt: new Date().toISOString() };
      } catch (error) {
        // AC6: an outcome that could not be proven, whatever the cause —
        // including a bug in this loop itself — is an explicit ambiguous
        // state, never a silently stuck 'executing'. redactSecrets matches
        // every other reason this module ever writes: the underlying error
        // can be a raw git/gh failure that echoes a credential.
        settled = {
          ...executing,
          state: 'ambiguous',
          reason: `Publication stopped unexpectedly: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          updatedAt: new Date().toISOString(),
        };
      }
      this.store.updateRunPublication(settled);
    })().finally(() => { this.livePublications.delete(run.id); });
    this.livePublications.set(run.id, task);
    return task;
  }
}
