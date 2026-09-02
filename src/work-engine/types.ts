import type { AgentType } from '../types.js';

export interface RunRepository {
  id: string;
  name: string;
  path: string;
}

/**
 * Ticket 10 AC2: the authenticated human, device, service, or runtime
 * identity that requested this Run (CONTEXT.md's "Principal") — recorded so
 * a commit AgentDeck makes on their behalf can say who asked for it,
 * distinct from the commit's own author identity (always AgentDeck's own —
 * see work-engine/commit.ts). Named collaborators with real device
 * credentials are tickets 11/12's job; until then every Run's Principal is
 * the single local operator running AgentDeck.
 */
export interface RunPrincipal {
  readonly id: string;
  readonly displayName: string;
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
  /**
   * Ticket 09 AC1's "Attempt count" / "repair cycles" hard limit — how many
   * repair rounds (ticket 08) a failing required gate may trigger before
   * verification gives up. Unset falls back to
   * verification.ts's MAX_VERIFICATION_REPAIR_ATTEMPTS, exactly ticket 08's
   * original behavior, so a WorkSpec that never mentions this keeps working
   * unchanged.
   */
  maxRepairAttempts?: number;
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
  /** Ticket 09 AC1/AC3: a hard resource limit (wall-clock duration today) was reached — distinct from a runtime failure, a verification failure, and a cancellation. */
  | 'failed_budget'
  | 'failed'
  /** Ticket 09 AC4: a pause was requested but the live Attempt has not yet reached a safe boundary to honor it — distinct from 'paused' itself. */
  | 'pause_requested'
  /** Ticket 09 AC4: the Attempt reached a safe boundary and stopped starting new work — distinct from the mere request. */
  | 'paused'
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

// Ticket 09: hard resource limits and safe controls. A Run's own frozen
// budget (WorkSpec.budget) never changes; these events are the durable
// record of the engine proactively enforcing it, or of an operator's
// pause/resume/cancel request being observed and acted on.

/**
 * A hard limit was reached and the engine stopped the Attempt itself
 * (AC1/AC3) — never a silent, unexplained stall.
 *
 * `limit` names only `maxWallClockMs` today: it is the only budget field
 * this event kind is ever actually produced for. `maxConcurrentProcesses`
 * and `maxChildRuns` are resolved into the frozen capability envelope's
 * processCeiling/childRunCeiling (envelope.ts) and enforced by ticket 04's
 * assertProcessCeiling/assertChildRunCeiling — but nothing in this codebase
 * yet spawns more than one process at a time for a Run, or creates a child
 * Run at all (childRunCeiling is 0 unconditionally), so there is no live
 * call site that could ever observe either ceiling being exceeded. Widening
 * this union ahead of that call site existing would advertise enforcement
 * this event can't actually deliver.
 */
export interface AttemptBudgetExceededEvent extends AttemptEventBase {
  readonly kind: 'budget-exceeded';
  readonly limit: 'maxWallClockMs';
  readonly configured: number;
  readonly observed: number;
}

/** An operator asked to pause — not yet honored; see AttemptPausedEvent for when it actually takes effect (AC4). */
export interface AttemptPauseRequestedEvent extends AttemptEventBase {
  readonly kind: 'pause-requested';
}

/** The Attempt reached its next safe boundary and stopped starting new work — the *effective* pause AC4 distinguishes from the mere request. */
export interface AttemptPausedEvent extends AttemptEventBase {
  readonly kind: 'paused';
}

/** An operator resumed a paused Attempt; the safe boundary it was blocked at proceeds. */
export interface AttemptResumedEvent extends AttemptEventBase {
  readonly kind: 'resumed';
}

// Ticket 10: the local-commit delivery step, attempted only once verification
// reaches 'verified' (AC1) — never for any other outcome. Exactly one of
// these two, or neither (nothing changed to commit), ever appears per
// Attempt; a commit-created/failed event never changes the Run's own
// verified status — that already settled — it only reports how delivery
// went (CONTEXT.md's Run result "delivery artifacts").

/** A local commit was created with AgentDeck's own automation identity (AC2) — never pushed, never a pull request (AC6). */
export interface AttemptCommitCreatedEvent extends AttemptEventBase {
  readonly kind: 'commit-created';
  readonly sha: string;
  readonly branch: string;
  /** Whether the commit carries a valid signature — signing is optional (AC3): false whenever it wasn't configured, or was configured but failed and AgentDeck fell back to an unsigned commit rather than losing the work. */
  readonly signed: boolean;
  readonly changedFiles: readonly string[];
}

/** Verification passed but the delivery commit itself could not be created — never carries raw signing/credential output (AC3). */
export interface AttemptCommitFailedEvent extends AttemptEventBase {
  readonly kind: 'commit-failed';
  readonly reason: string;
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
  | AttemptVerificationOutcomeEvent
  | AttemptBudgetExceededEvent
  | AttemptPauseRequestedEvent
  | AttemptPausedEvent
  | AttemptResumedEvent
  | AttemptCommitCreatedEvent
  | AttemptCommitFailedEvent;

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
  'budget-exceeded': ['kind', 'sequence', 'at', 'limit', 'configured', 'observed'],
  'pause-requested': ['kind', 'sequence', 'at'],
  paused: ['kind', 'sequence', 'at'],
  resumed: ['kind', 'sequence', 'at'],
  'commit-created': ['kind', 'sequence', 'at', 'sha', 'branch', 'signed', 'changedFiles'],
  'commit-failed': ['kind', 'sequence', 'at', 'reason'],
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
  /** Ticket 10 AC2: who requested this Run — frozen at submit(), exactly like spec. */
  readonly principal: RunPrincipal;
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

/** One resolved approval or input request, as it belongs in a Run result (ticket 10 AC4) — never the raw attention-requested/resolved event pair. */
export interface RunResultApproval {
  readonly attentionId: string;
  readonly kind: AttentionRequestKind;
  readonly reason: string;
  readonly decision: 'approved' | 'denied' | 'provided';
  readonly resolvedAt: string;
}

export interface RunResultCommit {
  readonly sha: string;
  readonly branch: string;
  readonly signed: boolean;
}

export interface RunResultUsage {
  readonly inputTokens: AttemptUsageAmount;
  readonly outputTokens: AttemptUsageAmount;
}

/**
 * Ticket 10 AC4: CONTEXT.md's "Run result" — "the durable terminal record of
 * a Run's outcome, including its submitted intent, delivery artifacts,
 * verification evidence, approvals, usage, budget state, and recovery
 * notes." Never its own stored record — see run-result.ts's deriveRunResult,
 * the only place one is ever produced, folded from the same durable state
 * (WorkSpec + the Attempt's event log) everything else in this file already
 * reads. Only ever produced once the Attempt has reached a terminal state
 * (AC7: a failed/cancelled/unrecoverable/completed-unverified Run gets one
 * too, honestly reporting that outcome — never only for success).
 */
export interface RunResult {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly outcome: RunStatus;
  readonly changedFiles: readonly string[];
  /** Absent whenever no local commit was created — an unverified/failed/cancelled outcome (AC7), a 'working-tree' delivery request, no changes to commit, or delivery itself failing (see recoveryNotes then). */
  readonly commit?: RunResultCommit;
  readonly verificationEvidence: readonly AttemptVerificationCheckEvent[];
  readonly approvals: readonly RunResultApproval[];
  readonly usage?: RunResultUsage;
  readonly budget: RunBudget;
  /** The precise reason behind a non-verified outcome — a runtime failure, a hard-limit abort, an unrecoverable restart, or (still 'completed') a failed delivery commit. Absent only for an ordinary verified success with nothing to note. */
  readonly recoveryNotes?: string;
}

export interface WorkEngine {
  submit(spec: WorkSpec): Promise<WorkRun>;
  get(runId: string): WorkRun | undefined;
  list(): WorkRun[];
  /** Resolves the exact base commit and creates a dedicated worktree. Idempotent once ready. */
  prepare(runId: string): Promise<WorkRun>;
  /**
   * Marks a Run cancelled without touching any worktree it already
   * prepared, its durable events, or any result already produced. Ticket 09
   * AC5: if the Attempt is still live in this process, this also stops its
   * runtime authority — the live adapter round is aborted (its own process
   * killed) rather than left running to a natural completion.
   */
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
  /**
   * Ticket 09 AC4: asks a live Attempt to stop starting new work at its next
   * supported safe boundary — never mid-flight — and durably records the
   * request. Never kills anything already running; see cancel() for that.
   * Resolves once the request is durable; the Attempt itself reports
   * 'paused' (not just 'pause_requested') only once it actually reaches
   * that boundary.
   */
  pause(runId: string): Promise<WorkRun>;
  /** Ticket 09 AC4: lets a paused (or pause-requested) Attempt proceed past the safe boundary it was waiting at. */
  resume(runId: string): Promise<WorkRun>;
}
