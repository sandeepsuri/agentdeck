// The Collaborator-safe projection of a Run.
//
// GET /api/runs and GET /api/runs/:id are the SAME routes the local admin
// uses, and a WorkRun is an admin's-eye record: spec.repository.path and
// preparation.worktreePath are absolute locations on the operator's machine,
// the frozen CapabilityEnvelope names readable roots, an environment
// allowlist and secret-grant references, and every VerificationGate carries
// the admin-authored shell command it runs. None of that is inside a
// Repository grant -- a grant says "you may see this Repository's work," not
// "you may see how this machine is laid out."
//
// So this module narrows a Run that has ALREADY been authorized for reading.
// It deliberately does not filter by grants (work-routes.ts's scopeRuns owns
// that) and deliberately does not decide authorization (work-engine/policy.ts
// owns that). It is the same boundary security.ts's publicSession draws for a
// Session, one layer further out; it lives in its own file rather than in
// security.ts because ws.ts imports security.ts on the per-frame hot path and
// that module has, deliberately, no work-engine dependency at all.
//
// The narrative, not the log: a Collaborator gets attempt-narrative.ts's
// derived labels ("Read src/auth/session.ts") instead of the AttemptEvent
// stream, because a tool-activity event's `summary` IS the literal command a
// runtime ran. That is the field-level guarantee. relativizePaths below is
// defense in depth on top of it, for the free text -- an assistant message, a
// failure reason -- that legitimately still crosses out and can mention a
// path the runtime typed itself.
import { summarizeAttempt, type AttemptSummary } from '../work-engine/attempt-narrative.js';
import { deriveRunResult } from '../work-engine/run-result.js';
import type {
  CollaboratorRunDetail, CollaboratorRunNarrative, CollaboratorRunResult, CollaboratorRunSummary, WorkRun,
} from '../work-engine/types.js';

export type {
  CollaboratorRunDetail, CollaboratorRunGate, CollaboratorRunNarrative, CollaboratorRunResult,
  CollaboratorRunStep, CollaboratorRunSummary,
} from '../work-engine/types.js';

/** How many narrated steps a detail response carries. A long Run's log is unbounded; its usefulness to a reader is not. */
const MAX_STEPS = 400;

/** Any absolute-looking POSIX path still embedded in free text after the known roots are rewritten. */
const ABSOLUTE_PATH = /(?:\/(?:Users|home|var|tmp|private|opt|etc)\b)(?:\/[^\s"'`,;:)\]}]*)*/g;

/**
 * Rewrites this Run's own worktree and Repository roots to '.', then masks any
 * other absolute path left behind. Best effort by construction -- it is
 * defense in depth over the field-level drops above, never the guarantee
 * itself. Longest root first, so a worktree nested under the Repository is
 * rewritten as the worktree rather than half-rewritten as the Repository.
 */
export function relativizePaths(text: string, roots: readonly string[]): string {
  const ordered = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const root of ordered) out = out.split(root).join('.');
  return out.replace(ABSOLUTE_PATH, '…');
}

/**
 * What a Collaborator is told about a failed preparation. The engine's own
 * message for a missing Repository verification policy is an instruction
 * addressed to the admin, and every other preparation error comes from
 * prepareRunWorktree carrying absolute paths -- so neither is passed through.
 */
function preparationNote(run: WorkRun): string | undefined {
  if (run.preparation.state !== 'failed') return undefined;
  return run.preparation.error?.startsWith('No verification policy is configured')
    ? 'This Repository has no verification policy configured yet, so work cannot start. Ask the admin to set one up.'
    : 'AgentDeck could not prepare a workspace for this Run. Ask the admin to check it.';
}

function runRoots(run: WorkRun): readonly string[] {
  return [run.preparation.worktreePath, run.spec.repository.path].filter((value): value is string => Boolean(value));
}

export function collaboratorRunSummary(run: WorkRun): CollaboratorRunSummary {
  const note = preparationNote(run);
  return {
    id: run.id,
    status: run.status,
    objective: run.spec.objective,
    acceptanceCriteria: run.spec.acceptanceCriteria,
    repository: { id: run.spec.repository.id, name: run.spec.repository.name },
    submittedAt: run.submittedAt,
    requestedBy: run.principal.displayName,
    preparation: { state: run.preparation.state, ...(note ? { note } : {}) },
    attemptState: run.attempt.state,
    ...(run.pendingAttention ? { pendingAttentionKind: run.pendingAttention.kind } : {}),
  };
}

function narrate(run: WorkRun): CollaboratorRunNarrative {
  const roots = runRoots(run);
  const events = run.attempt.state === 'idle' ? [] : run.attempt.events;
  const summary: AttemptSummary = summarizeAttempt(events);
  const stepsTruncated = summary.steps.length > MAX_STEPS;
  return {
    ...(summary.answer ? { answer: relativizePaths(summary.answer, roots) } : {}),
    // The tail, not the head: the newest steps are the ones a reader is
    // following. Dropping `detail` here is what keeps raw commands server-side.
    steps: summary.steps.slice(-MAX_STEPS).map((step) => ({
      label: relativizePaths(step.label, roots), status: step.status, sequence: step.sequence,
    })),
    stepsTruncated,
    ...(summary.outcome ? { outcome: {
      kind: summary.outcome.kind,
      ...(summary.outcome.detail ? { detail: relativizePaths(summary.outcome.detail, roots) } : {}),
    } } : {}),
    ...(summary.usage ? { usage: summary.usage } : {}),
  };
}

function narrowResult(run: WorkRun): CollaboratorRunResult | undefined {
  const result = deriveRunResult(run);
  if (!result) return undefined;
  const roots = runRoots(run);
  return {
    outcome: result.outcome,
    changedFiles: result.changedFiles.map((file) => relativizePaths(file, roots)),
    ...(result.commit ? { commit: result.commit } : {}),
    ...(result.delivery ? { delivery: {
      outcome: result.delivery.outcome,
      ...(result.delivery.branch ? { branch: result.delivery.branch } : {}),
      ...(result.delivery.reason ? { reason: relativizePaths(result.delivery.reason, roots) } : {}),
    } } : {}),
    verification: result.verificationEvidence.map((check) => ({
      gate: check.gate, required: check.required, passed: check.passed,
    })),
    approvals: result.approvals.map((approval) => ({
      ...approval, reason: relativizePaths(approval.reason, roots),
    })),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.recoveryNotes ? { recoveryNotes: relativizePaths(result.recoveryNotes, roots) } : {}),
  };
}

export function collaboratorRunDetail(run: WorkRun): CollaboratorRunDetail {
  const roots = runRoots(run);
  const result = narrowResult(run);
  return {
    ...collaboratorRunSummary(run),
    requestedBaseReference: run.spec.requestedBaseReference,
    ...(run.spec.profileId ? { profileId: run.spec.profileId } : {}),
    narrative: narrate(run),
    ...(run.pendingAttention ? { pendingAttention: {
      ...run.pendingAttention, reason: relativizePaths(run.pendingAttention.reason, roots),
    } } : {}),
    ...(result ? { result } : {}),
  };
}
