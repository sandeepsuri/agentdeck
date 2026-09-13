// Redesign spec §04: "Needs You" — the one global attention queue that Home,
// the sidebar badge, and Work's "Needs you" filter all read. Derived purely
// from data App.tsx already fetches; nothing here is stored or resolved.
// Resolving an item always happens through the existing Run/Session paths.
import type { CollaboratorSession, Conflict, Repo, Session } from '../types.js';
import type { RateLimitSnapshot, RateLimitWindow } from '../usage/types.js';
import type { RunReviewState } from '../work-engine/run-review.js';
import type { CollaboratorRunSummary, WorkRun } from '../work-engine/types.js';
import { parseApprovalReason } from './risk.js';

export type NeedsYouKind = 'permission' | 'question' | 'conflict' | 'error' | 'usage' | 'review';
export type NeedsYouAction = 'Respond' | 'Answer' | 'Review' | 'Resolve';
export type NeedsYouTarget =
  | { kind: 'run'; runId: string; attentionId?: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'repository'; repositoryId: string }
  | { kind: 'usage' };

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  action: NeedsYouAction;
  title: string;
  context: string;
  detail?: string;
  occurredAt: string;
  target: NeedsYouTarget;
}

export interface NeedsYouInput {
  runs: readonly WorkRun[];
  sessions: readonly Session[];
  conflicts: readonly Conflict[];
  reviewStates?: ReadonlyMap<string, RunReviewState>;
  rateLimits?: readonly RateLimitSnapshot[];
  now?: number;
}

const URGENCY: Record<NeedsYouKind, number> = { permission: 0, question: 1, conflict: 2, error: 2, usage: 3, review: 4 };
const FAILED_STATUSES = new Set(['failed', 'failed_budget', 'failed_verification']);
/** Failures older than this stop demanding attention; they stay browsable in Work. */
const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Conflict kinds that can actually block work — same-repository and dirty-tree notices are advisory only. */
const BLOCKING_CONFLICTS = new Set<Conflict['kind']>(['file_overlap', 'dependency_wait']);
export const USAGE_ALERT_PERCENT = 80;

function agentName(runtime: string | undefined): string {
  return runtime === 'codex' ? 'Codex' : 'Claude';
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function windowLabel(window: RateLimitWindow): string {
  if (window.windowMinutes >= 7 * 24 * 60) return 'weekly';
  if (window.windowMinutes >= 24 * 60) return 'daily';
  return `${Math.round(window.windowMinutes / 60)}-hour`;
}

function hasReviewDecision(state: RunReviewState | undefined): boolean {
  return state?.state === 'reviewed' || state?.state === 'changes_requested';
}

export function deriveNeedsYou({ runs, sessions, conflicts, reviewStates, rateLimits = [], now = Date.now() }: NeedsYouInput): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  for (const run of runs) {
    const context = `${run.spec.objective} · ${run.spec.repository.name}`;
    const pending = run.pendingAttention;
    if (pending) {
      const parsed = parseApprovalReason(pending.reason);
      const agent = parsed.agent ?? agentName(run.spec.runtimePreference[0]);
      items.push(pending.kind === 'approval'
        ? {
          id: `run:${run.id}:attention:${pending.id}`, kind: 'permission', action: 'Respond',
          title: `${agent} needs permission`, context, detail: parsed.command ?? pending.reason,
          occurredAt: pending.requestedAt, target: { kind: 'run', runId: run.id, attentionId: pending.id },
        }
        : {
          id: `run:${run.id}:attention:${pending.id}`, kind: 'question', action: 'Answer',
          title: `${agent} has a question`, context, detail: pending.reason,
          occurredAt: pending.requestedAt, target: { kind: 'run', runId: run.id, attentionId: pending.id },
        });
      continue;
    }
    const review = reviewStates?.get(run.id);
    if (FAILED_STATUSES.has(run.status) && !hasReviewDecision(review) && now - Date.parse(run.submittedAt) <= FAILURE_WINDOW_MS) {
      items.push({
        id: `run:${run.id}:failed`, kind: 'error', action: 'Resolve',
        title: run.status === 'failed_verification' ? 'Verification failed' : run.status === 'failed_budget' ? 'Hit its budget limit' : 'Work failed',
        context, occurredAt: run.submittedAt, target: { kind: 'run', runId: run.id },
      });
      continue;
    }
    if (review?.state === 'ready_to_review' && run.publication?.state !== 'succeeded') {
      items.push({
        id: `run:${run.id}:review`, kind: 'review', action: 'Review',
        title: 'Ready for review', context, occurredAt: run.submittedAt, target: { kind: 'run', runId: run.id },
      });
    }
  }

  for (const session of sessions) {
    if (session.status !== 'waiting_input') continue;
    const repo = session.worktreePath ?? session.repoId ?? session.cwd;
    items.push({
      id: `session:${session.id}:waiting`, kind: 'question', action: 'Respond',
      title: `${agentName(session.agent)} is waiting for you`,
      context: `${session.name ?? session.taskId ?? `${agentName(session.agent)} session`} · ${basename(repo)}`,
      occurredAt: session.lastActivityAt, target: { kind: 'session', sessionId: session.id },
    });
  }

  for (const conflict of conflicts) {
    if (!BLOCKING_CONFLICTS.has(conflict.kind)) continue;
    items.push({
      id: `conflict:${conflict.repoId}:${conflict.kind}:${conflict.sessionIds.join(',')}`, kind: 'conflict', action: 'Resolve',
      title: conflict.kind === 'file_overlap' ? 'Agents are editing the same files' : 'Work is blocked on a dependency',
      context: basename(conflict.repoId), detail: conflict.detail,
      occurredAt: new Date(now).toISOString(), target: { kind: 'repository', repositoryId: conflict.repoId },
    });
  }

  for (const snapshot of rateLimits) {
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window || window.usedPercent < USAGE_ALERT_PERCENT) continue;
      items.push({
        id: `usage:${snapshot.provider}:${window.windowMinutes}`, kind: 'usage', action: 'Review',
        title: `${agentName(snapshot.provider)} ${windowLabel(window)} limit ${Math.round(window.usedPercent)}%`,
        context: window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Usage threshold crossed',
        occurredAt: snapshot.observedAt, target: { kind: 'usage' },
      });
    }
  }

  return sortNeedsYou(items);
}

function sortNeedsYou(items: NeedsYouItem[]): NeedsYouItem[] {
  return items.sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * Redesign spec §10: the collaborator's view of the same queue, built from
 * the collaborator-safe projections (no paths, no approval authority). Only
 * what a collaborator can act on appears: questions from their Runs and
 * agents waiting for a reply. Approvals stay admin-only (policy.ts).
 */
export function deriveCollaboratorNeedsYou({ runs, sessions, repos }: {
  runs: readonly CollaboratorRunSummary[];
  sessions: readonly CollaboratorSession[];
  repos: readonly Repo[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const run of runs) {
    if (run.pendingAttentionKind !== 'input') continue;
    items.push({
      id: `run:${run.id}:input`, kind: 'question', action: 'Answer', title: 'An agent has a question',
      context: `${run.objective} · ${run.repository.name}`, occurredAt: run.submittedAt, target: { kind: 'run', runId: run.id },
    });
  }
  for (const session of sessions) {
    if (session.status !== 'waiting_input') continue;
    items.push({
      id: `session:${session.id}:waiting`, kind: 'question', action: 'Respond',
      title: `${agentName(session.agent)} is waiting for you`,
      context: `${session.name ?? `${agentName(session.agent)} session`} · ${repos.find((repo) => repo.id === session.repoId)?.name ?? 'Repository'}`,
      occurredAt: session.lastActivityAt, target: { kind: 'session', sessionId: session.id },
    });
  }
  return sortNeedsYou(items);
}
