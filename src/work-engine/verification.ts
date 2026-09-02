// Ticket 08: verify and repair a managed Run. Required gates are resolved
// from a Repository's admin-approved RepositoryVerificationPolicy and frozen
// onto the Run once, before its Attempt executes (freezeVerificationPolicy);
// after the Attempt reports completion, the frozen gates — never the live
// policy — decide whether the Run reaches a verified outcome (engine.ts's
// runVerification), with a bounded repair cycle for a runtime that fails
// them.
import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { RepositoryVerificationPolicy, RunVerificationPolicyState, VerificationGate } from './types.js';

/** Freezes a Repository's admin-approved policy (or its absence) into the Run-durable state (ticket 08 AC1/AC8). */
export function freezeVerificationPolicy(policy: RepositoryVerificationPolicy | undefined): RunVerificationPolicyState {
  if (!policy) {
    return {
      state: 'missing',
      reason: 'No verification configuration is approved for this Repository. Configure required gates or an '
        + 'explicit no-verification declaration before running managed work against it.',
    };
  }
  if (policy.kind === 'no-verification') return { state: 'declared-unverified' };
  return { state: 'ready', requiredGates: policy.gates };
}

/** Bounded repair cycle (ticket 08 AC5/AC6): a runtime gets this many chances to fix failing gates before verification is exhausted. */
export const MAX_VERIFICATION_REPAIR_ATTEMPTS = 2;

/** Evidence stays concise (AC5) — bounded so a runaway command's output can never blow up durable storage or the repair prompt. */
const MAX_EVIDENCE_LENGTH = 2000;

function truncateEvidence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_EVIDENCE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_EVIDENCE_LENGTH)}\n… (truncated)`;
}

export interface GateExecutionResult {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly evidence: string;
}

/** Runs one verification gate's exact command in the prepared worktree, never anywhere else. */
export type VerificationGateRunner = (gate: VerificationGate, worktreePath: string) => Promise<GateExecutionResult>;

export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60_000;

/** The real implementation: `command` runs through the shell inside `worktreePath`, bounded by `timeoutMs`. */
export function createShellVerificationGateRunner(timeoutMs: number = DEFAULT_GATE_TIMEOUT_MS): VerificationGateRunner {
  return (gate, worktreePath) => new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', gate.command],
      { cwd: worktreePath, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (execError: ExecFileException | null, stdout, stderr) => {
        const combined = `${stdout}${stderr}`.trim();
        if (execError?.killed && execError.signal) {
          resolve({
            passed: false,
            exitCode: -1,
            evidence: truncateEvidence(`Timed out after ${timeoutMs}ms and was killed.\n${combined}`),
          });
          return;
        }
        const exitCode = execError ? (typeof execError.code === 'number' ? execError.code : 1) : 0;
        resolve({
          passed: exitCode === 0,
          exitCode,
          evidence: truncateEvidence(combined || (exitCode === 0 ? '(no output)' : `exited ${exitCode}`)),
        });
      },
    );
  });
}

export interface FailingGateEvidence {
  readonly gate: VerificationGate;
  readonly required: boolean;
  readonly result: GateExecutionResult;
}

/** The concise, factual repair instruction handed back to the same runtime (ticket 08 AC5) — never a vague "fix it". */
export function buildRepairObjective(originalObjective: string, failing: readonly FailingGateEvidence[]): string {
  const details = failing.map(({ gate, result }) => (
    `- ${gate.name} (\`${gate.command}\`) exited ${result.exitCode}:\n${result.evidence}`
  )).join('\n\n');
  return `${originalObjective}\n\nThe previous attempt did not pass required verification. Fix the following and `
    + `make sure they pass, without changing what they check:\n\n${details}`;
}
