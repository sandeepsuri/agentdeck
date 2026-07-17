import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { AgentMessage, Repo, Session, Task } from '../types.js';
import { BusWatcher, agentsDir } from './bus.js';
import { renderStatusMarkdown } from './status.js';

const hasConcreteAgentIdentity = (message: AgentMessage): boolean =>
  !message.agent.endsWith(':unknown');

export class CoordinationService {
  private watchers = new Map<string, BusWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private store: Store, private manager: SessionManager) {}

  async syncRepos(repos: Repo[]): Promise<void> {
    for (const repo of repos) {
      if (this.watchers.has(repo.path)) continue;
      const watcher = new BusWatcher(repo.path, (message) => this.ingest(repo.path, message));
      this.watchers.set(repo.path, watcher);
      await watcher.start();
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timers.clear();
  }

  /** Bind a newly discovered process to a hook event that arrived first. */
  reconcileSession(session: Session): Session {
    if (session.agentSessionId) return session;
    const repoPath = session.worktreePath ?? session.repoId ?? session.cwd;
    const event = this.store.listEvents({ repo: repoPath, limit: 250 }).reverse().find((candidate) => {
      if (!hasConcreteAgentIdentity(candidate)) return false;
      if (candidate.agent.split(':')[0] !== session.agent) return false;
      if (Date.parse(candidate.ts) < Date.parse(session.startedAt)) return false;
      if (candidate.sessionId === session.id || candidate.agent === session.agentSessionId) return true;
      if (session.pid !== undefined && candidate.sourcePids?.includes(session.pid)) return true;
      return session.tty !== undefined && candidate.tty === session.tty;
    });
    if (!event) return session;
    const updated = event.agent === session.agentSessionId
      ? session
      : { ...session, agentSessionId: event.agent };
    if (updated !== session) {
      this.store.upsertSession(updated);
      this.manager.publishSessionUpdate(updated);
    }
    if (event.status) this.manager.applyHookStatus(updated.id, event.status, event.ts);
    return this.manager.getSession(updated.id) ?? updated;
  }

  private ingest(repoPath: string, message: AgentMessage): void {
    this.store.appendEvent(message);
    if (!hasConcreteAgentIdentity(message)) {
      this.manager.publishAgentEvent(message);
      return;
    }
    const messageAt = Date.parse(message.ts);
    const candidates = this.store.listSessions().filter((session) =>
      session.status !== 'exited' && session.agent === message.agent.split(':')[0]
      && (session.repoId === repoPath || session.cwd.startsWith(`${repoPath}${path.sep}`) || session.cwd === repoPath));
    const currentCandidates = candidates.filter((candidate) =>
      !Number.isFinite(messageAt) || messageAt >= Date.parse(candidate.startedAt));
    let session = message.sessionId
      ? currentCandidates.find((candidate) => candidate.id === message.sessionId)
      : currentCandidates.find((candidate) => candidate.agentSessionId === message.agent);
    if (!session && message.sourcePids?.length) {
      session = currentCandidates.find((candidate) =>
        candidate.pid !== undefined && message.sourcePids!.includes(candidate.pid));
    }
    if (!session && message.tty) {
      const ttyMatches = currentCandidates.filter((candidate) => candidate.tty === message.tty);
      if (ttyMatches.length === 1) session = ttyMatches[0];
    }
    if (session && session.agentSessionId !== message.agent) {
      session = { ...(this.manager.getSession(session.id) ?? session), agentSessionId: message.agent };
      this.store.upsertSession(session);
      this.manager.publishSessionUpdate(session);
    }
    if (session && message.status) this.manager.applyHookStatus(session.id, message.status, message.ts);
    if (message.task) this.updateTask(repoPath, message, session?.id);
    if (session && message.task && session.taskId !== message.task) {
      const updated = { ...(this.manager.getSession(session.id) ?? session), taskId: message.task };
      this.store.upsertSession(updated);
      this.manager.publishSessionUpdate(updated);
    }
    this.manager.publishAgentEvent(message);
    const prior = this.timers.get(repoPath);
    if (prior) clearTimeout(prior);
    this.timers.set(repoPath, setTimeout(() => this.writeStatus(repoPath), 100));
  }

  private updateTask(repoPath: string, message: AgentMessage, sessionId?: string): void {
    const existing = this.store.getTask(message.task!);
    const sessionIds = new Set(existing?.sessionIds ?? []);
    if (sessionId) sessionIds.add(sessionId);
    const task: Task = {
      id: message.task!,
      title: existing?.title ?? message.task!,
      repoId: existing?.repoId ?? repoPath,
      status: this.taskStatus(message, existing?.status),
      sessionIds: [...sessionIds],
    };
    const dependsOn = message.dependsOn ?? existing?.dependsOn;
    if (dependsOn) task.dependsOn = dependsOn;
    this.store.saveTask(task);
  }

  private taskStatus(message: AgentMessage, prior: Task['status'] | undefined): Task['status'] {
    if (message.event === 'done') return 'done';
    if (message.event === 'blocked') return 'blocked';
    if (message.event === 'claim' || message.event === 'progress' || message.event === 'session_start') return 'in_progress';
    return prior ?? 'todo';
  }

  private writeStatus(repoPath: string): void {
    const entries = this.store.listEvents({ repo: repoPath, limit: 1000 });
    fs.mkdirSync(agentsDir(repoPath), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(repoPath), 'STATUS.md'), renderStatusMarkdown(repoPath, entries));
  }
}
