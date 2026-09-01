import type { AgentType } from '../types.js';

export interface RunRepository {
  id: string;
  name: string;
  path: string;
}

export interface RunBudget {
  maxWallClockMs?: number;
  maxModelTurns?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxChildRuns?: number;
  maxToolCalls?: number;
  maxConcurrentProcesses?: number;
  maxCostUsd?: number;
}

export interface VerificationIntent {
  required: boolean;
  commands: string[];
}

export type RequestedDeliveryResult = 'working-tree' | 'local-commit' | 'pull-request';

/** The complete user intent frozen when a durable Run is submitted. */
export interface WorkSpec {
  objective: string;
  acceptanceCriteria: string[];
  repository: RunRepository;
  requestedBaseReference: string;
  runtimePreference: AgentType[];
  budget: RunBudget;
  verificationIntent: VerificationIntent;
  requestedDeliveryResult: RequestedDeliveryResult;
}

export type RunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'waiting_dependency'
  | 'verifying'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Progress of preparing a dedicated, clean Git worktree for a Run, from its
 * frozen requestedBaseReference — resolved before any runtime receives
 * authority over the Repository (ticket 03).
 */
export type RunPreparationState = 'pending' | 'in_progress' | 'ready' | 'failed';

export interface RunPreparation {
  readonly state: RunPreparationState;
  /** Exact commit SHA requestedBaseReference resolved to, locally, with no implicit fetch. */
  readonly baseCommit?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** Precise, recoverable explanation set only when state is 'failed'. */
  readonly error?: string;
}

/** A redacted pointer to secret material held in external secret storage. Never the secret value itself (ticket 04). */
export interface SecretGrant {
  readonly name: string;
  readonly reference: string;
}

/** The admin-approved capability boundary enforced for one Run's chosen runtime, before it receives authority (ticket 04). */
export interface EnvelopeProfile {
  readonly writableWorktree: string;
  readonly readableRoots: readonly string[];
  /** Empty by default — tool network access is denied unless a domain is explicitly granted here. */
  readonly allowedNetworkDomains: readonly string[];
  /** Only these variable names may be copied from the host shell; every other variable is dropped. */
  readonly environmentAllowlist: readonly string[];
  readonly processCeiling: number;
  readonly childRunCeiling: number;
}

export interface CapabilityEnvelope {
  readonly runtime: AgentType;
  readonly profile: EnvelopeProfile;
  readonly secretGrants: readonly SecretGrant[];
}

export type RunEnvelopeState =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly capabilityEnvelope: CapabilityEnvelope }
  /** Set when no preferred runtime can satisfy the envelope — refused rather than silently degraded. */
  | { readonly state: 'refused'; readonly reason: string };

// Ticket 05: the shared Attempt event model every runtime adapter (Codex
// here, Claude in ticket 14) must translate its own protocol into. Nothing
// runtime-specific — no provider conversation identity, no raw transport
// fields — ever appears in one of these; that stays inside the adapter.

/** An exact token count, or 'unknown' when the runtime did not report one — never coerced to zero. */
export type AttemptUsageAmount = number | 'unknown';

interface AttemptEventBase {
  /** Strictly increasing within one Attempt, starting at 0 — the ordering contract every adapter must honor. */
  readonly sequence: number;
  readonly at: string;
}

export interface AttemptLifecycleEvent extends AttemptEventBase {
  readonly kind: 'lifecycle';
  readonly phase: 'attempt-started' | 'turn-started' | 'turn-completed';
}

export interface AttemptMessageEvent extends AttemptEventBase {
  readonly kind: 'message';
  readonly role: 'assistant';
  readonly text: string;
}

export interface AttemptToolActivityEvent extends AttemptEventBase {
  readonly kind: 'tool-activity';
  readonly tool: string;
  readonly status: 'started' | 'completed' | 'failed';
  readonly summary?: string;
}

export interface AttemptUsageEvent extends AttemptEventBase {
  readonly kind: 'usage';
  readonly inputTokens: AttemptUsageAmount;
  readonly outputTokens: AttemptUsageAmount;
}

export interface AttemptCompletionEvent extends AttemptEventBase {
  readonly kind: 'completion';
  readonly outcome: 'success' | 'no-changes';
  readonly summary?: string;
}

export interface AttemptFailureEvent extends AttemptEventBase {
  readonly kind: 'failure';
  readonly reason: string;
}

export type AttemptEvent =
  | AttemptLifecycleEvent
  | AttemptMessageEvent
  | AttemptToolActivityEvent
  | AttemptUsageEvent
  | AttemptCompletionEvent
  | AttemptFailureEvent;

interface AttemptRunBase {
  readonly runtime: AgentType;
  readonly startedAt: string;
  readonly events: readonly AttemptEvent[];
}

/**
 * The state of the one Attempt a Run has started (ticket 05 starts exactly
 * one; retries/continuation are later tickets). idle until start(); running
 * accumulates events as the adapter reports them; completed/failed freeze
 * the final ordered event history alongside the terminal event's own detail.
 */
export type AttemptState =
  | { readonly state: 'idle' }
  | (AttemptRunBase & { readonly state: 'running' })
  | (AttemptRunBase & { readonly state: 'completed'; readonly completedAt: string })
  | (AttemptRunBase & { readonly state: 'failed'; readonly failedAt: string; readonly reason: string });

export interface WorkRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly spec: WorkSpec;
  readonly submittedAt: string;
  readonly preparation: RunPreparation;
  readonly envelope: RunEnvelopeState;
  readonly attempt: AttemptState;
}

export interface WorkEngine {
  submit(spec: WorkSpec): Promise<WorkRun>;
  get(runId: string): WorkRun | undefined;
  list(): WorkRun[];
  /** Resolves the exact base commit and creates a dedicated worktree. Idempotent once ready. */
  prepare(runId: string): Promise<WorkRun>;
  /** Marks a Run cancelled without touching any worktree it already prepared. */
  cancel(runId: string): Promise<WorkRun>;
  /**
   * Starts the Run's one Attempt in its prepared worktree, inside its frozen
   * capability envelope (ticket 05). Resolves once the Attempt has begun
   * (status 'running'); the Attempt itself keeps progressing in the
   * background and is observed by rereading the Run (get/list).
   */
  start(runId: string): Promise<WorkRun>;
}
