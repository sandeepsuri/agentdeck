// Redesign spec §06: one "Work" concept in the UI. Runs and Sessions stay
// distinct internally (CONTEXT.md), but Work lists them side by side with the
// same fields and the same status buckets, so Operations, Sessions, Grid,
// History and Signals no longer need to be separate destinations.
import type { AgentType, Repo, Session } from '../types.js';
import type { RunReviewState } from '../work-engine/run-review.js';
import type { RunStatus, WorkRun } from '../work-engine/types.js';
import type { NeedsYouItem } from './needsYou.js';
import { STATUS_LABELS, repoPathOf, sessionLabel } from './workspace/model.js';
import { isTerminalRunStatus } from './workspace/runModel.js';

export type WorkBucket = 'needs_you' | 'working' | 'review' | 'completed' | 'archived';
export type WorkStatusFilter = 'all' | WorkBucket;
export type WorkTone = 'working' | 'waiting' | 'error' | 'done' | 'neutral';

export const WORK_STATUS_FILTERS: { id: WorkStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
];

export interface WorkItem {
  id: string;
  kind: 'run' | 'session';
  title: string;
  agent: AgentType;
  agentLabel: 'Claude' | 'Codex';
  repositoryId: string | null;
  repositoryName: string;
  bucket: WorkBucket;
  statusLabel: string;
  tone: WorkTone;
  startedAt: string;
  updatedAt: string;
  run?: WorkRun;
  session?: Session;
}

export interface WorkFilters {
  status: WorkStatusFilter;
  repositoryId?: string | null;
  agent?: AgentType | null;
  query?: string;
}

/** Finished work older than this moves from Completed to Archived. */
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued', preparing: 'Preparing', running: 'Working', waiting_approval: 'Waiting for approval',
  waiting_input: 'Waiting for input', waiting_dependency: 'Waiting on dependency', verifying: 'Verifying',
  reviewing: 'Reviewing', pause_requested: 'Pausing', paused: 'Paused', completed: 'Completed',
  completed_unverified: 'Completed (unverified)', failed_verification: 'Verification failed',
  failed_budget: 'Budget exceeded', failed: 'Failed', cancelled: 'Cancelled',
};

function runTone(status: RunStatus): WorkTone {
  if (status.startsWith('failed')) return 'error';
  if (status.startsWith('waiting') || status === 'pause_requested' || status === 'paused') return 'waiting';
  if (status === 'completed' || status === 'completed_unverified') return 'done';
  if (status === 'cancelled') return 'neutral';
  return 'working';
}

function sessionTone(status: Session['status']): WorkTone {
  if (status === 'waiting_input') return 'waiting';
  if (status === 'working' || status === 'starting') return 'working';
  if (status === 'completed') return 'done';
  return 'neutral';
}

function agentLabel(agent: AgentType): 'Claude' | 'Codex' {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

export function repositoryForSession(session: Pick<Session, 'cwd' | 'repoId' | 'worktreePath'>, repos: readonly Repo[]): Repo | undefined {
  const path = session.worktreePath ?? session.repoId ?? session.cwd;
  return repos.find((repo) => repo.id === path || repo.path === path || repo.id === session.repoId)
    ?? repos.find((repo) => session.cwd === repo.path || session.cwd.startsWith(`${repo.path}/`));
}

export function deriveWorkItems({ runs, sessions, historySessions, repos, needsYou, reviewStates, now = Date.now() }: {
  runs: readonly WorkRun[];
  sessions: readonly Session[];
  historySessions: readonly Session[];
  repos: readonly Repo[];
  needsYou: readonly NeedsYouItem[];
  reviewStates?: ReadonlyMap<string, RunReviewState>;
  now?: number;
}): WorkItem[] {
  const needsRun = new Set<string>();
  const needsSession = new Set<string>();
  for (const item of needsYou) {
    if (item.kind === 'review') continue;
    if (item.target.kind === 'run') needsRun.add(item.target.runId);
    if (item.target.kind === 'session') needsSession.add(item.target.sessionId);
  }

  const items: WorkItem[] = [];
  const pushSession = (session: Session, archived: boolean) => {
    const repo = repositoryForSession(session, repos);
    const path = repoPathOf(session);
    const ended = session.status === 'exited' || session.status === 'completed';
    items.push({
      id: `session:${session.id}`, kind: 'session', title: sessionLabel(session),
      agent: session.agent, agentLabel: agentLabel(session.agent),
      repositoryId: repo?.id ?? null, repositoryName: repo?.name ?? path.split('/').filter(Boolean).pop() ?? path,
      bucket: archived ? 'archived' : needsSession.has(session.id) ? 'needs_you' : ended ? 'completed' : 'working',
      statusLabel: STATUS_LABELS[session.status], tone: sessionTone(session.status),
      startedAt: session.startedAt, updatedAt: session.endedAt ?? session.lastActivityAt, session,
    });
  };
  for (const session of sessions) pushSession(session, false);
  for (const session of historySessions) pushSession(session, true);

  for (const run of runs) {
    const review = reviewStates?.get(run.id);
    const readyForReview = review?.state === 'ready_to_review' && run.publication?.state !== 'succeeded';
    const terminal = isTerminalRunStatus(run.status);
    const bucket: WorkBucket = needsRun.has(run.id) ? 'needs_you'
      : readyForReview ? 'review'
        : !terminal ? 'working'
          : now - Date.parse(run.submittedAt) > ARCHIVE_AFTER_MS ? 'archived' : 'completed';
    const statusLabel = readyForReview ? 'Ready for review'
      : review?.state === 'reviewed' ? 'Reviewed'
        : review?.state === 'changes_requested' ? 'Changes requested'
          : RUN_STATUS_LABELS[run.status];
    const agent: AgentType = run.envelope.state === 'ready' ? run.envelope.capabilityEnvelope.runtime : run.spec.runtimePreference[0] ?? 'claude';
    items.push({
      id: `run:${run.id}`, kind: 'run', title: run.spec.objective,
      agent, agentLabel: agentLabel(agent),
      repositoryId: run.spec.repository.id, repositoryName: run.spec.repository.name,
      bucket, statusLabel, tone: readyForReview ? 'waiting' : runTone(run.status),
      startedAt: run.submittedAt, updatedAt: run.pendingAttention?.requestedAt ?? run.submittedAt, run,
    });
  }

  const bucketOrder = (item: WorkItem) => item.bucket === 'needs_you' ? 0 : 1;
  return items.sort((a, b) => bucketOrder(a) - bucketOrder(b) || b.updatedAt.localeCompare(a.updatedAt));
}

export function filterWorkItems(items: readonly WorkItem[], { status, repositoryId, agent, query }: WorkFilters): WorkItem[] {
  const words = query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return items.filter((item) => {
    if (status !== 'all' && item.bucket !== status) return false;
    if (repositoryId && item.repositoryId !== repositoryId) return false;
    if (agent && item.agent !== agent) return false;
    if (words.length === 0) return true;
    const haystack = [item.title, item.repositoryName, item.agentLabel, item.statusLabel, item.session?.branch].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function countWorkBuckets(items: readonly WorkItem[]): Record<WorkStatusFilter, number> {
  const counts: Record<WorkStatusFilter, number> = { all: items.length, needs_you: 0, working: 0, review: 0, completed: 0, archived: 0 };
  for (const item of items) counts[item.bucket] += 1;
  return counts;
}
