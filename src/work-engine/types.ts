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
  /** Ticket 08 AC7: the Repository explicitly declares no verification — never conflated with ordinary success. */
  | 'completed_unverified'
  /** Ticket 08 AC6: required verification gates never passed within the bounded repair cycle — distinct from a plain runtime 'failed' and from 'cancelled'. */
  | 'failed_verification'
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

// Ticket 08: verification gates. A VerificationGate is a durable-evidence
// unit — a name and the exact shell command that decides pass/fail. Required
// gates come from a Repository's admin-approved RepositoryVerificationPolicy,
// resolved and frozen onto a Run before its Attempt executes (see
// RunVerificationPolicyState); the runtime can never redefine them because
// the Run only ever reads its own already-frozen copy again, never the
// policy source. Supplemental gates come from the requester's own
// WorkSpec.verificationIntent.commands and may only add checks, never stand
// in for a required one.
export interface VerificationGate {
  readonly name: string;
  readonly command: string;
}

/**
 * The admin-approved verification declaration for one Repository — resolved
 * from AgentDeck's own store, never from anything inside the Repository's
 * working tree, so a runtime with write access to the worktree structurally
 * cannot influence it (ticket 08 AC2). 'required' lists at least one gate
 * every Run against this Repository must pass; 'no-verification' is an
 * explicit admin declaration that this Repository is not verified — distinct
 * from no policy having been configured at all (see RunVerificationPolicyState's
 * 'missing', which is never inferred from this type).
 */
export type RepositoryVerificationPolicy =
  | { readonly kind: 'required'; readonly gates: readonly VerificationGate[] }
  | { readonly kind: 'no-verification' };

/**
 * The Repository verification policy resolved and frozen onto a Run once,
 * during prepare() — alongside RunPreparation and RunEnvelopeState — and
 * never re-read afterward. A later change to the Repository's approved
 * policy (an admin edit, or a hostile one) can never retroactively alter an
 * already-frozen Run (ticket 08 AC1/AC2).
 */
export type RunVerificationPolicyState =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly requiredGates: readonly VerificationGate[] }
  | { readonly state: 'declared-unverified' }
  /** No RepositoryVerificationPolicy is configured at all — surfaced explicitly rather than silently treated as 'declared-unverified' (ticket 08 AC8). */
  | { readonly state: 'missing'; readonly reason: string };

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

// Ticket 07: the runtime asked for something before it could continue — an
// approval (may this proceed?) or clarifying input (what should this be?).
// `attentionId` is the stable correlation every resolve command (REST, WS,
// local UI, mobile UI) references; it is minted by the runtime adapter, not
// derived from any provider request id, so it never carries provider
// conversation identity onto a durable event (same boundary ticket 05/06
// already hold for every other AttemptEvent kind).
export type AttentionRequestKind = 'approval' | 'input';

export interface AttemptAttentionRequestedEvent extends AttemptEventBase {
  readonly kind: 'attention-requested';
  readonly attentionId: string;
  readonly attentionKind: AttentionRequestKind;
  readonly reason: string;
}

export interface AttemptAttentionResolvedEvent extends AttemptEventBase {
  readonly kind: 'attention-resolved';
  readonly attentionId: string;
  readonly decision: 'approved' | 'denied' | 'provided';
  /** Only present when decision is 'provided' — the clarifying text relayed to the runtime, and nothing else (ticket 07 AC5). */
  readonly input?: string;
}

// Ticket 08: durable, per-gate command-and-result evidence (AC4/AC5) — one
// event per gate, per verification pass, whether it was a required gate from
// the frozen RepositoryVerificationPolicy or a supplemental one the
// requester selected. `evidence` is deliberately concise (bounded output,
// never a raw unbounded log) so a runaway command can't blow up durable
// storage, and so it stays "concise failure evidence" when handed back to
// the runtime for a repair attempt.
export interface AttemptVerificationCheckEvent extends AttemptEventBase {
  readonly kind: 'verification-check';
  readonly gate: string;
  readonly command: string;
  readonly required: boolean;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly evidence: string;
}

export type VerificationOutcome = 'verified' | 'unverified' | 'failed_verification';

/**
 * The single event that concludes verification for one Attempt — always
 * exactly one, always last, exactly like completion/failure conclude an
 * Attempt's own runtime execution (see projectAttemptState). `repairAttempts`
 * is how many repair rounds ran before this outcome was reached (0 for a
 * first-pass pass, an immediate 'unverified', or a 'failed_verification'
 * from missing configuration with nothing to repair).
 */
export interface AttemptVerificationOutcomeEvent extends AttemptEventBase {
  readonly kind: 'verification-outcome';
  readonly outcome: VerificationOutcome;
  readonly repairAttempts: number;
}

export type AttemptEvent =
  | AttemptLifecycleEvent
  | AttemptMessageEvent
  | AttemptToolActivityEvent
  | AttemptUsageEvent
  | AttemptCompletionEvent
  | AttemptFailureEvent
  | AttemptAttentionRequestedEvent
  | AttemptAttentionResolvedEvent
  | AttemptVerificationCheckEvent
  | AttemptVerificationOutcomeEvent;

/**
 * The one canonical field list per AttemptEvent kind — the single source of
 * truth both the runtime-adapter contract (adapter.contract.ts, ticket 05)
 * and the durable-persistence layer (durable-events.ts, ticket 06) check
 * against, so the two can never drift apart from hand-maintaining separate
 * copies of the same shape.
 */
export const ATTEMPT_EVENT_FIELDS: Readonly<Record<AttemptEvent['kind'], readonly string[]>> = {
  lifecycle: ['kind', 'sequence', 'at', 'phase'],
  message: ['kind', 'sequence', 'at', 'role', 'text'],
  'tool-activity': ['kind', 'sequence', 'at', 'tool', 'status', 'summary'],
  usage: ['kind', 'sequence', 'at', 'inputTokens', 'outputTokens'],
  completion: ['kind', 'sequence', 'at', 'outcome', 'summary'],
  failure: ['kind', 'sequence', 'at', 'reason'],
  'attention-requested': ['kind', 'sequence', 'at', 'attentionId', 'attentionKind', 'reason'],
  'attention-resolved': ['kind', 'sequence', 'at', 'attentionId', 'decision', 'input'],
  'verification-check': ['kind', 'sequence', 'at', 'gate', 'command', 'required', 'passed', 'exitCode', 'evidence'],
  'verification-outcome': ['kind', 'sequence', 'at', 'outcome', 'repairAttempts'],
};

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

/** Folded live from the durable event log (see attempt-projection.ts's deriveOpenAttentionRequest) — never its own stored record. */
export interface RunAttentionRequest {
  readonly id: string;
  readonly kind: AttentionRequestKind;
  readonly reason: string;
  readonly requestedAt: string;
}

/** What an operator decided for one pending RunAttentionRequest, from whichever transport carried it (ticket 07 AC2). */
export type AttentionDecisionInput =
  | { readonly kind: 'approve' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'input'; readonly value: string };

export interface WorkRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly spec: WorkSpec;
  readonly submittedAt: string;
  readonly preparation: RunPreparation;
  readonly envelope: RunEnvelopeState;
  /** Ticket 08: the Repository's admin-approved verification policy, resolved and frozen once preparation completes. */
  readonly verificationPolicy: RunVerificationPolicyState;
  readonly attempt: AttemptState;
  /**
   * Optional rather than always-present so existing WorkRun literals across
   * the test suite need no update — absent means "nothing pending" exactly
   * like an explicit undefined everywhere this is read. Only ever set while
   * attempt.state is 'running' (see deriveOpenAttentionRequest).
   */
  readonly pendingAttention?: RunAttentionRequest;
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
  /**
   * Called once at boot (ticket 06), before any caller can reach this
   * engine: every Run left 'running' when the previous process stopped has
   * no surviving Attempt to observe, and is ended with a precise,
   * deterministic unrecoverable reason rather than left stuck. Never
   * re-invokes a runtime adapter — recovery only records a terminal fact.
   */
  recover(): Promise<void>;
  /**
   * Ticket 07: the one policy path every transport (local UI, mobile UI,
   * REST, WebSocket) resolves a pending approval or input request through.
   * Resolves the returned WorkRun once the durable attention-resolved event
   * is persisted and (if the Attempt is still live in this process) the
   * runtime adapter has been handed the decision. Rejects with
   * RunAttentionNotPendingError when attentionId is not the Run's current
   * pending request — already resolved, superseded, or the Attempt ended
   * (including via recover()) — so a decision can never reopen or double-
   * apply to a request that is no longer waiting.
   */
  resolveAttention(runId: string, attentionId: string, decision: AttentionDecisionInput): Promise<WorkRun>;
}
