import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { AgentMessage, Repo, Task } from '../types.js';
import { BusWatcher, agentsDir } from './bus.js';
import { renderStatusMarkdown } from './status.js';

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

  private ingest(repoPath: string, message: AgentMessage): void {
    this.store.appendEvent(message);
    const candidates = this.store.listSessions().filter((session) =>
      session.status !== 'exited' && session.agent === message.agent.split(':')[0]
      && (session.repoId === repoPath || session.cwd.startsWith(`${repoPath}${path.sep}`) || session.cwd === repoPath));
    const session = candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
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
