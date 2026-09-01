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

export interface WorkRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly spec: WorkSpec;
  readonly submittedAt: string;
  readonly preparation: RunPreparation;
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
