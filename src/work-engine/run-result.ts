// Ticket 10 AC4: CONTEXT.md's "Run result" — folded, on every read, from the
// same durable state everything else in this package reads (WorkSpec, the
// Attempt's event log, and the already-derived RunStatus) — never its own
// stored record, exactly the house style ticket 06 established for
// AttemptState and ticket 07/08/09 extended for attention/verification/
// budget state. Produced for every terminal Run, not only a successful one
// (AC7): a failed, cancelled, unrecoverable, or completed-unverified Run
// still gets an honest result reporting that outcome.
import type {
  AttemptEvent, RunResult, RunResultApproval, WorkRun,
} from './types.js';

function deriveApprovals(events: readonly AttemptEvent[]): RunResultApproval[] {
  const requests = new Map<string, Extract<AttemptEvent, { kind: 'attention-requested' }>>();
  const approvals: RunResultApproval[] = [];
  for (const event of events) {
    if (event.kind === 'attention-requested') {
      requests.set(event.attentionId, event);
    } else if (event.kind === 'attention-resolved') {
      const request = requests.get(event.attentionId);
      if (!request) continue;
      approvals.push({
        attentionId: event.attentionId,
        kind: request.attentionKind,
        reason: request.reason,
        decision: event.decision,
        resolvedAt: event.at,
      });
    }
  }
  return approvals;
}

/** Undefined while the Attempt hasn't reached a terminal state yet — a result only ever describes a settled Run. */
export function deriveRunResult(run: WorkRun): RunResult | undefined {
  if (run.attempt.state === 'idle' || run.attempt.state === 'running') return undefined;
  const { events } = run.attempt;

  const commitCreated = events.find((event): event is Extract<AttemptEvent, { kind: 'commit-created' }> => (
    event.kind === 'commit-created'
  ));
  const commitFailed = events.find((event): event is Extract<AttemptEvent, { kind: 'commit-failed' }> => (
    event.kind === 'commit-failed'
  ));
  const verificationEvidence = events.filter((event): event is Extract<AttemptEvent, { kind: 'verification-check' }> => (
    event.kind === 'verification-check'
  ));
  const lastUsage = [...events].reverse().find((event): event is Extract<AttemptEvent, { kind: 'usage' }> => (
    event.kind === 'usage'
  ));
  const verificationOutcome = events.find((event): event is Extract<AttemptEvent, { kind: 'verification-outcome' }> => (
    event.kind === 'verification-outcome'
  ));
  // AC7: every non-success outcome gets an honest, synthesized note — a
  // runtime failure's own reason, a failed delivery commit, or (a gap a
  // review of this ticket caught) repairs exhausted without ever passing,
  // which otherwise reported only raw verification-check evidence with no
  // "why" narrative alongside it.
  const recoveryNotes = run.attempt.state === 'failed'
    ? run.attempt.reason
    : commitFailed?.reason ?? (verificationOutcome?.outcome === 'failed_verification'
      ? `Verification did not pass after ${verificationOutcome.repairAttempts} repair attempt(s).`
      : undefined);

  return {
    objective: run.spec.objective,
    acceptanceCriteria: run.spec.acceptanceCriteria,
    outcome: run.status,
    changedFiles: commitCreated?.changedFiles ?? [],
    ...(commitCreated ? { commit: { sha: commitCreated.sha, branch: commitCreated.branch, signed: commitCreated.signed } } : {}),
    verificationEvidence,
    approvals: deriveApprovals(events),
    ...(lastUsage ? { usage: { inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens } } : {}),
    budget: run.spec.budget,
    ...(recoveryNotes ? { recoveryNotes } : {}),
  };
}
