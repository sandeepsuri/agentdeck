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

export interface WorkRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly spec: WorkSpec;
  readonly submittedAt: string;
  readonly preparation: RunPreparation;
  readonly envelope: RunEnvelopeState;
}

export interface WorkEngine {
  submit(spec: WorkSpec): Promise<WorkRun>;
  get(runId: string): WorkRun | undefined;
  list(): WorkRun[];
  /** Resolves the exact base commit and creates a dedicated worktree. Idempotent once ready. */
  prepare(runId: string): Promise<WorkRun>;
  /** Marks a Run cancelled without touching any worktree it already prepared. */
  cancel(runId: string): Promise<WorkRun>;
}
