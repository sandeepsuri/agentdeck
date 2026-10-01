// Phone work: what the owner phone's Work tab and Needs you list show. These
// are small, stable shapes made for the phone, not the Mac's own payloads:
// a full WorkRun carries every Attempt event and could outgrow one relay
// frame, and a Session row carries its launch spec. Pure functions over the
// Mac's own state, so the list, Needs you and push notifications always
// agree about what is waiting.
import path from 'node:path';
import { deriveAttentionItems } from '../attention.js';
import type { StoredSessionInteraction } from '../store/index.js';
import type { AgentMessage, AgentType, RunFeedbackEntry, Session, SessionStatus } from '../types.js';
import { deriveRunResult } from '../work-engine/run-result.js';
import { deriveRunReviewState, type RunReviewState } from '../work-engine/run-review.js';
import type { AttemptEvent, RunStatus, WorkRun } from '../work-engine/types.js';

const MAX_SESSIONS = 50;
const MAX_RUNS = 50;
const MAX_TIMELINE = 60;
const MAX_TEXT = 600;
/** Ended work stays in Recent this long. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;

export type PhoneNeedKind = 'session-approval' | 'session-question' | 'session-waiting' | 'run-attention' | 'run-review';

export interface PhoneNeed {
  /** Stable while the same thing is waiting, so a push is sent once. */
  id: string;
  kind: PhoneNeedKind;
  sessionId?: string;
  runId?: string;
  title: string;
  detail?: string;
  at: string;
}

export interface PhoneSession {
  id: string;
  name: string;
  agent: AgentType;
  origin: Session['origin'];
  repoId?: string;
  repoName: string;
  branch?: string;
  status: SessionStatus;
  live: boolean;
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  need?: PhoneNeedKind;
}

export interface PhoneRunSummary {
  id: string;
  objective: string;
  repoId: string;
  repoName: string;
  status: RunStatus;
  runtime?: AgentType;
  submittedAt: string;
  updatedAt: string;
  attemptCount: number;
  pendingAttention?: { id: string; kind: 'approval' | 'input'; reason: string; requestedAt: string };
  review: RunReviewState['state'];
}

export interface PhoneTimelineItem {
  at: string;
  label: string;
  detail?: string;
  tone: 'done' | 'now' | 'failed' | 'info';
}

export interface PhoneRunDetail extends PhoneRunSummary {
  acceptanceCriteria: string[];
  baseReference: string;
  delivery: WorkRun['spec']['requestedDeliveryResult'];
  budgetMinutes?: number;
  elapsedMinutes?: number;
  /** The worktree the review diff is read from, once prepared. */
  worktreePath?: string;
  branch?: string;
  timeline: PhoneTimelineItem[];
  result?: {
    outcome: RunStatus;
    summary?: string;
    changedFiles: string[];
    commit?: { sha: string; branch: string };
    applied: boolean;
    checks: { name: string; passed: boolean }[];
    notes?: string;
  };
  publication?: { state: string; target: string; url?: string };
  actions: {
    prepare: boolean; start: boolean; pause: boolean; resume: boolean; cancel: boolean;
    retry: boolean; apply: boolean; publish: boolean; review: boolean;
  };
}

const clip = (text: string | undefined, max = MAX_TEXT) => {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export function sessionName(session: Session): string {
  return session.name ?? session.taskId ?? `${session.agent === 'claude' ? 'Claude Code' : 'Codex'} session`;
}

const repoPathOf = (session: Session) => session.worktreePath ?? session.repoId ?? session.cwd;

export interface WorkState {
  sessions: readonly Session[];
  isLive: (session: Session) => boolean;
  interactions: (sessionId: string) => readonly StoredSessionInteraction[];
  events: readonly (AgentMessage & { eventId?: number })[];
  runs: readonly WorkRun[];
  feedback: (taskId: string) => readonly RunFeedbackEntry[];
  now?: number;
}

/** Everything waiting on the owner, newest first. */
export function deriveNeeds(state: WorkState): PhoneNeed[] {
  const needs: PhoneNeed[] = [];
  const asked = new Set<string>();
  for (const session of state.sessions) {
    if (session.status === 'exited') continue;
    const pending = state.interactions(session.id).filter((row) => row.status === 'pending');
    for (const row of pending) {
      asked.add(session.id);
      needs.push({
        id: `interaction:${row.id}`,
        kind: row.kind === 'approval' ? 'session-approval' : 'session-question',
        sessionId: session.id,
        title: sessionName(session),
        detail: clip(row.kind === 'approval' && row.context ? `${row.question}: ${row.context}` : row.question, 200),
        at: row.requestedAt,
      });
    }
  }
  for (const item of deriveAttentionItems([...state.sessions], [...state.events])) {
    if (asked.has(item.sessionId)) continue;
    needs.push({
      id: `attention:${item.id}`,
      kind: 'session-waiting',
      sessionId: item.sessionId,
      title: item.sessionName,
      detail: clip(item.message, 200) ?? 'Waiting for your reply',
      at: item.occurredAt,
    });
  }
  for (const run of state.runs) {
    if (run.pendingAttention) {
      needs.push({
        id: `run-attention:${run.pendingAttention.id}`,
        kind: 'run-attention',
        runId: run.id,
        title: clip(run.spec.objective, 120)!,
        detail: clip(run.pendingAttention.reason, 200),
        at: run.pendingAttention.requestedAt,
      });
    } else if (deriveRunReviewState(run, state.feedback(run.taskId)).state === 'ready_to_review') {
      needs.push({
        id: `run-review:${run.id}:${run.attempts?.length ?? 1}`,
        kind: 'run-review',
        runId: run.id,
        title: clip(run.spec.objective, 120)!,
        detail: reviewDetail(run),
        at: settledAt(run),
      });
    }
  }
  return needs.sort((a, b) => b.at.localeCompare(a.at));
}

/** Needs worth a push: something the owner must decide, not an agent pausing between turns. */
export function pushWorthy(need: PhoneNeed): boolean {
  return need.kind !== 'session-waiting';
}

export function phoneSessions(state: WorkState, needs: readonly PhoneNeed[]): PhoneSession[] {
  const now = state.now ?? Date.now();
  const needBySession = new Map<string, PhoneNeedKind>();
  for (const need of needs) if (need.sessionId && !needBySession.has(need.sessionId)) needBySession.set(need.sessionId, need.kind);
  return state.sessions
    .filter((session) => {
      if (session.status !== 'exited') return true;
      // Only AgentDeck's own sessions are kept once ended; a discovered one is gone with its process.
      return session.origin === 'managed' && now - Date.parse(session.endedAt ?? session.lastActivityAt) < RECENT_MS;
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, MAX_SESSIONS)
    .map((session) => {
      const repo = repoPathOf(session);
      const need = needBySession.get(session.id);
      return {
        id: session.id,
        name: sessionName(session),
        agent: session.agent,
        origin: session.origin,
        ...(session.repoId ? { repoId: session.repoId } : {}),
        repoName: path.basename(repo),
        ...(session.branch ? { branch: session.branch } : {}),
        status: session.status,
        live: state.isLive(session),
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        ...(session.endedAt ? { endedAt: session.endedAt } : {}),
        ...(need ? { need } : {}),
      };
    });
}

export function phoneRuns(state: WorkState): PhoneRunSummary[] {
  const now = state.now ?? Date.now();
  return state.runs
    .filter((run) => !isSettled(run.status) || now - Date.parse(settledAt(run)) < RECENT_MS)
    .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)))
    .slice(0, MAX_RUNS)
    .map((run) => runSummary(run, state.feedback(run.taskId)));
}

export function runSummary(run: WorkRun, feedback: readonly RunFeedbackEntry[]): PhoneRunSummary {
  const runtime = run.envelope.state === 'ready' ? run.envelope.capabilityEnvelope.runtime : run.spec.runtimePreference[0];
  return {
    id: run.id,
    objective: run.spec.objective,
    repoId: run.spec.repository.id,
    repoName: run.spec.repository.name,
    status: run.status,
    ...(runtime ? { runtime } : {}),
    submittedAt: run.submittedAt,
    updatedAt: updatedAt(run),
    attemptCount: Math.max(run.attempts?.length ?? 0, run.attempt.state === 'idle' ? 0 : 1),
    ...(run.pendingAttention ? { pendingAttention: { ...run.pendingAttention } } : {}),
    review: deriveRunReviewState(run, feedback).state,
  };
}

export function runDetail(run: WorkRun, feedback: readonly RunFeedbackEntry[], now = Date.now()): PhoneRunDetail {
  const summary = runSummary(run, feedback);
  const result = deriveRunResult(run);
  const attempt = run.attempt;
  const started = attempt.state === 'idle' ? undefined : Date.parse(attempt.startedAt);
  const finished = attempt.state === 'completed' ? Date.parse(attempt.completedAt) : attempt.state === 'failed' ? Date.parse(attempt.failedAt) : now;
  const live = attempt.state === 'running';
  const settled = attempt.state === 'completed' || attempt.state === 'failed';
  const completion = attempt.state === 'idle' ? undefined
    : [...attempt.events].reverse().find((event): event is Extract<AttemptEvent, { kind: 'completion' }> => event.kind === 'completion');
  const applied = result?.delivery?.outcome === 'applied';
  const publication = run.publication;
  return {
    ...summary,
    acceptanceCriteria: [...run.spec.acceptanceCriteria],
    baseReference: run.spec.requestedBaseReference,
    delivery: run.spec.requestedDeliveryResult,
    ...(run.spec.budget.maxWallClockMs ? { budgetMinutes: Math.round(run.spec.budget.maxWallClockMs / 60_000) } : {}),
    ...(started !== undefined ? { elapsedMinutes: Math.max(0, Math.round((finished - started) / 60_000)) } : {}),
    ...(run.preparation.worktreePath ? { worktreePath: run.preparation.worktreePath } : {}),
    ...(run.preparation.branch ? { branch: run.preparation.branch } : {}),
    timeline: timeline(run),
    ...(result ? {
      result: {
        outcome: result.outcome,
        ...(clip(completion?.summary, 2000) ? { summary: clip(completion?.summary, 2000) } : {}),
        changedFiles: [...result.changedFiles],
        ...(result.commit ? { commit: { sha: result.commit.sha, branch: result.commit.branch } } : {}),
        applied,
        checks: result.verificationEvidence.map((check) => ({ name: check.gate, passed: check.passed })),
        ...(result.recoveryNotes ? { notes: clip(result.recoveryNotes, 1000) } : {}),
      },
    } : {}),
    ...(publication ? {
      publication: {
        state: publication.state, target: publication.target,
        ...(publication.result?.pullRequest?.url ? { url: publication.result.pullRequest.url } : {}),
      },
    } : {}),
    actions: {
      prepare: run.status === 'queued' && run.preparation.state !== 'ready',
      start: run.preparation.state === 'ready' && attempt.state === 'idle',
      pause: live && run.status !== 'pause_requested' && run.status !== 'paused',
      resume: run.status === 'pause_requested' || run.status === 'paused',
      cancel: !isSettled(run.status),
      retry: settled && run.status !== 'completed' && run.status !== 'cancelled',
      apply: Boolean(result?.commit) && attempt.state === 'completed' && !applied,
      publish: run.status === 'completed' && Boolean(result?.commit)
        && (!publication || publication.state === 'failed' || publication.state === 'ambiguous'),
      review: settled,
    },
  };
}

function timeline(run: WorkRun): PhoneTimelineItem[] {
  const items: PhoneTimelineItem[] = [{ at: run.submittedAt, label: 'Submitted', detail: clip(run.spec.objective, 200), tone: 'done' }];
  if (run.preparation.state === 'ready') {
    items.push({ at: run.submittedAt, label: 'Prepared', detail: `Worktree from ${run.spec.requestedBaseReference}`, tone: 'done' });
  } else if (run.preparation.state === 'failed') {
    items.push({ at: run.submittedAt, label: 'Preparation failed', detail: clip(run.preparation.error, 300), tone: 'failed' });
  }
  if (run.attempt.state === 'idle') return items;
  for (const event of run.attempt.events) {
    const item = timelineItem(event);
    if (item) items.push(item);
  }
  if (run.attempt.state === 'failed') items.push({ at: run.attempt.failedAt, label: 'Failed', detail: clip(run.attempt.reason, 300), tone: 'failed' });
  // Keep the start and the latest; a long Attempt has hundreds of tool calls.
  return items.length > MAX_TIMELINE ? [...items.slice(0, 2), ...items.slice(-(MAX_TIMELINE - 2))] : items;
}

function timelineItem(event: AttemptEvent): PhoneTimelineItem | undefined {
  switch (event.kind) {
    case 'lifecycle':
      return event.phase === 'attempt-started' ? { at: event.at, label: 'Started', tone: 'done' } : undefined;
    case 'message':
      return { at: event.at, label: 'Agent', detail: clip(event.text, 300), tone: 'info' };
    case 'tool-activity':
      return event.status === 'started' ? undefined
        : { at: event.at, label: event.tool, detail: clip(event.summary, 200), tone: event.status === 'failed' ? 'failed' : 'done' };
    case 'attention-requested':
      return { at: event.at, label: event.attentionKind === 'approval' ? 'Asked for approval' : 'Asked for input', detail: clip(event.reason, 300), tone: 'now' };
    case 'attention-resolved':
      return { at: event.at, label: event.decision === 'approved' ? 'Approved' : event.decision === 'denied' ? 'Denied' : 'Input given', tone: 'done' };
    case 'verification-check':
      return { at: event.at, label: `Check: ${event.gate}`, detail: event.passed ? 'Passed' : `Failed (exit ${event.exitCode})`, tone: event.passed ? 'done' : 'failed' };
    case 'verification-outcome':
      return { at: event.at, label: event.outcome === 'verified' ? 'Verified' : event.outcome === 'unverified' ? 'Not verified' : 'Verification failed', tone: event.outcome === 'failed_verification' ? 'failed' : 'done' };
    case 'budget-exceeded':
      return { at: event.at, label: 'Time limit reached', tone: 'failed' };
    case 'pause-requested':
      return { at: event.at, label: 'Pause requested', tone: 'info' };
    case 'paused':
      return { at: event.at, label: 'Paused', tone: 'now' };
    case 'resumed':
      return { at: event.at, label: 'Resumed', tone: 'done' };
    case 'completion':
      return { at: event.at, label: event.outcome === 'no-changes' ? 'Finished with no changes' : 'Finished', detail: clip(event.summary, 300), tone: 'done' };
    case 'failure':
      return { at: event.at, label: 'Agent failed', detail: clip(event.reason, 300), tone: 'failed' };
    case 'commit-created':
      return { at: event.at, label: 'Committed', detail: `${event.sha.slice(0, 7)} on ${event.branch} · ${event.changedFiles.length} files`, tone: 'done' };
    case 'commit-failed':
      return { at: event.at, label: 'Commit failed', detail: clip(event.reason, 300), tone: 'failed' };
    case 'delivery-outcome':
      return { at: event.at, label: event.outcome === 'applied' ? 'Applied to repository' : 'Not applied', detail: clip(event.reason ?? event.branch, 300), tone: event.outcome === 'applied' ? 'done' : 'failed' };
    default:
      return undefined;
  }
}

const SETTLED: ReadonlySet<RunStatus> = new Set([
  'completed', 'completed_unverified', 'failed_verification', 'failed_budget', 'failed', 'cancelled',
]);

function isSettled(status: RunStatus): boolean {
  return SETTLED.has(status);
}

function settledAt(run: WorkRun): string {
  if (run.attempt.state === 'completed') return run.attempt.completedAt;
  if (run.attempt.state === 'failed') return run.attempt.failedAt;
  return updatedAt(run);
}

function updatedAt(run: WorkRun): string {
  if (run.attempt.state === 'idle') return run.submittedAt;
  return run.attempt.events.at(-1)?.at ?? run.attempt.startedAt;
}

function reviewDetail(run: WorkRun): string | undefined {
  const result = deriveRunResult(run);
  if (!result) return undefined;
  const files = result.changedFiles.length;
  const checks = result.verificationEvidence.length;
  const passed = result.verificationEvidence.every((check) => check.passed);
  return `${files} file${files === 1 ? '' : 's'} changed${checks ? ` · checks ${passed ? 'passed' : 'failed'}` : ''}`;
}
