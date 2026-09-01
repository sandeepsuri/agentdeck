import path from 'node:path';
import type {
  AgentMessage, AttentionItem, CompanionAgent, CompanionAgentStatus, RunAttentionItem, Session,
} from './types.js';
import type { WorkRun } from './work-engine/types.js';

type ArchivedMessage = AgentMessage & { eventId?: number };

function sessionForEvent(sessions: Session[], event: ArchivedMessage): Session | undefined {
  if (event.sessionId) return sessions.find((session) => session.id === event.sessionId);
  const exact = sessions.find((session) => session.agentSessionId === event.agent);
  if (exact) return exact;
  const agent = event.agent.split(':')[0];
  const candidates = sessions.filter((session) =>
    session.agent === agent
    && (session.repoId === event.repo || session.cwd === event.repo || session.cwd.startsWith(`${event.repo}${path.sep}`))
    && Date.parse(event.ts) >= Date.parse(session.startedAt));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function itemFor(session: Session, event: ArchivedMessage): AttentionItem | undefined {
  let kind = event.attention;
  if (!kind && (event.event === 'done' || event.event === 'message') && !event.agent.startsWith('dashboard:')) {
    kind = 'reply';
  }
  if (!kind && event.status === 'waiting_input') kind = 'action_required';
  if (!kind) return undefined;
  const repo = session.worktreePath ?? session.repoId ?? session.cwd;
  const item: AttentionItem = {
    id: event.turnId
      ? `${event.agent}:${event.turnId}:${kind}`
      : event.eventId !== undefined
        ? `event:${event.eventId}:${kind}`
        : `${session.id}:${event.ts}:${kind}`,
    kind,
    sessionId: session.id,
    agent: session.agent,
    sessionName: session.name ?? session.taskId ?? `${session.agent === 'claude' ? 'Claude Code' : 'Codex'} session`,
    repo,
    repoName: path.basename(repo),
    occurredAt: event.ts,
  };
  if (event.message) item.message = event.message;
  if (session.branch) item.branch = session.branch;
  return item;
}

/**
 * Return at most one current attention item per live session. A newer working
 * signal clears an earlier reply/prompt, while CPU-only idle changes do not.
 */
export function deriveAttentionItems(
  sessions: Session[],
  events: ArchivedMessage[],
): AttentionItem[] {
  const live = sessions.filter((session) => session.status !== 'exited');
  const latest = new Map<string, AttentionItem | null>();
  for (const event of events) {
    const session = sessionForEvent(live, event);
    if (!session) continue;
    if (event.status === 'working' || event.event === 'session_end') {
      latest.set(session.id, null);
      continue;
    }
    const item = itemFor(session, event);
    if (item) latest.set(session.id, item);
  }
  for (const session of live) {
    if (session.status !== 'waiting_input' || latest.has(session.id)) continue;
    const repo = session.worktreePath ?? session.repoId ?? session.cwd;
    latest.set(session.id, {
      // Stable per session+kind: a waiting session whose lastActivityAt keeps
      // advancing must not mint a new id each snapshot, or the companion would
      // re-notify and re-expand on every tick.
      id: `${session.id}:action_required`,
      kind: 'action_required',
      sessionId: session.id,
      agent: session.agent,
      sessionName: session.name ?? session.taskId ?? `${session.agent === 'claude' ? 'Claude Code' : 'Codex'} session`,
      repo,
      repoName: path.basename(repo),
      occurredAt: session.lastActivityAt,
      ...(session.branch ? { branch: session.branch } : {}),
    });
  }
  const priority = { action_required: 0, response_required: 1, reply: 2 } as const;
  return [...latest.values()]
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => priority[a.kind] - priority[b.kind] || b.occurredAt.localeCompare(a.occurredAt));
}

/**
 * Ticket 07: the same minimal, purpose-built read model the mobile REST
 * endpoint, GET /api/companion, and the WS companion_snapshot push all share
 * — a managed Run's Repository path, budget, envelope, and full spec never
 * appear here, only what a human needs to decide an approval or input
 * request (the objective, the request's own reason, and its correlation).
 */
export function deriveRunAttentionItems(runs: readonly WorkRun[]): RunAttentionItem[] {
  return runs
    .flatMap((run) => (run.pendingAttention ? [{ run, pending: run.pendingAttention }] : []))
    .map(({ run, pending }) => ({
      runId: run.id,
      attentionId: pending.id,
      objective: run.spec.objective,
      kind: pending.kind,
      reason: pending.reason,
      requestedAt: pending.requestedAt,
    }))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

const companionPriority: Record<CompanionAgentStatus, number> = {
  action: 0,
  waiting: 1,
  reply: 2,
  working: 3,
  starting: 4,
  offline: 5,
};

function statusFor(session: Session, attention?: AttentionItem): CompanionAgentStatus | undefined {
  if (attention?.kind === 'action_required') return 'action';
  if (attention?.kind === 'response_required') return 'waiting';
  if (attention?.kind === 'reply') return 'reply';
  if (session.status === 'working') return 'working';
  if (session.status === 'starting') return 'starting';
  return undefined;
}

/** Normalize live session/event state into the notch-specific presentation contract. */
export function deriveCompanionAgents(
  sessions: Session[],
  events: ArchivedMessage[],
  attention = deriveAttentionItems(sessions, events),
): CompanionAgent[] {
  const attentionBySession = new Map(attention.map((item) => [item.sessionId, item]));
  const latestMessage = new Map<string, ArchivedMessage>();
  const latestProgress = new Map<string, number>();
  for (const event of events) {
    const session = sessionForEvent(sessions, event);
    if (!session || Date.parse(event.ts) < Date.parse(session.startedAt)) continue;
    if (typeof event.progress === 'number' && Number.isFinite(event.progress)
      && event.progress >= 0 && event.progress <= 100) {
      latestProgress.set(session.id, event.progress);
    }
    if (!event.agent.startsWith('dashboard:') && event.message?.trim()
      && ['progress', 'status', 'blocked', 'claim', 'done', 'message'].includes(event.event)) {
      latestMessage.set(session.id, event);
    }
  }

  return sessions.flatMap((session): CompanionAgent[] => {
    const item = attentionBySession.get(session.id);
    const status = statusFor(session, item);
    if (!status) return [];
    const repo = session.worktreePath ?? session.repoId ?? session.cwd;
    const task = item?.message?.trim()
      || latestMessage.get(session.id)?.message?.trim()
      || session.name?.trim()
      || session.taskId?.trim()
      || (status === 'starting' ? 'Starting agent' : `Working in ${path.basename(repo)}`);
    const agent: CompanionAgent = {
      id: session.id,
      agent: session.agent,
      name: session.agent === 'claude' ? 'Claude Code' : 'Codex',
      repo,
      repoName: path.basename(repo),
      task,
      status,
      updatedAt: item?.occurredAt ?? session.lastActivityAt,
    };
    if (session.branch) agent.branch = session.branch;
    const progress = latestProgress.get(session.id);
    if (progress !== undefined) agent.progress = progress;
    if (item) agent.attentionId = item.id;
    return [agent];
  }).sort((a, b) =>
    companionPriority[a.status] - companionPriority[b.status]
    || b.updatedAt.localeCompare(a.updatedAt));
}
