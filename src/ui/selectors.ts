import type { AgentMessage, AgentType, Repo, Session, SessionOrigin, SessionStatus } from '../types.js';

export interface SessionFilters {
  query?: string;
  repo?: string;
  agent?: AgentType;
  status?: SessionStatus;
  origin?: SessionOrigin;
}

export type GroupBy = 'repo' | 'agent' | 'status' | 'origin' | 'none';

export interface SessionGroup {
  key: string;
  label: string;
  sessions: Session[];
}

export function filterSessions(sessions: Session[], filters: SessionFilters): Session[] {
  const query = filters.query?.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filters.repo && session.repoId !== filters.repo) return false;
    if (filters.agent && session.agent !== filters.agent) return false;
    if (filters.status && session.status !== filters.status) return false;
    if (filters.origin && session.origin !== filters.origin) return false;
    if (!query) return true;
    return [session.name, session.cwd, session.branch, session.taskId, session.agent]
      .some((value) => value?.toLowerCase().includes(query));
  });
}

export interface ConversationEntry {
  ts: string;
  from: 'you' | 'agent';
  agent: string;
  text: string;
}

/** Dashboard↔agent conversation for exactly one AgentDeck/CLI session. */
export function conversationFor(
  events: AgentMessage[],
  sessionId: string,
  agentSessionId?: string,
): ConversationEntry[] {
  const seen = new Set<string>();
  return events
    .filter((event) => {
      if (!event.message) return false;
      if (event.agent.startsWith('dashboard:')) return event.agent === `dashboard:${sessionId}`;
      return event.sessionId === sessionId
        || (agentSessionId !== undefined && event.agent === agentSessionId);
    })
    .flatMap((event): ConversationEntry[] => {
      const fromDashboard = event.agent === `dashboard:${sessionId}`;
      if (!fromDashboard && event.event !== 'done' && event.event !== 'message') return [];
      const key = event.turnId
        ? `${event.agent}|${event.turnId}`
        : `${event.ts}|${event.agent}|${event.event}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ts: event.ts, from: fromDashboard ? 'you' : 'agent', agent: event.agent, text: event.message! }];
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

export function groupSessions(sessions: Session[], groupBy: GroupBy, repos: Repo[]): SessionGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: 'All sessions', sessions }];
  const repoNames = new Map(repos.map((repo) => [repo.id, repo.name]));
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = groupBy === 'repo'
      ? (session.repoId ?? 'unassigned')
      : session[groupBy];
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups].map(([key, groupedSessions]) => ({
    key,
    label: groupBy === 'repo'
      ? (key === 'unassigned' ? 'No repository' : (repoNames.get(key) ?? key))
      : key.replaceAll('_', ' '),
    sessions: groupedSessions,
  }));
}
