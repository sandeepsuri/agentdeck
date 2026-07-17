import type { Conflict, FileClaim, Repo, Session, Task } from '../types.js';

export function deriveConflicts(sessions: Session[], repos: Repo[], claims: FileClaim[], tasks: Task[] = []): Conflict[] {
  const conflicts: Conflict[] = [];
  const active = sessions.filter((session) => session.status !== 'exited' && session.status !== 'completed');
  for (const repo of repos) {
    const repoSessions = active.filter((session) => session.repoId === repo.id);
    if (repoSessions.length >= 2) conflicts.push({ kind: 'same_repo', repoId: repo.id, sessionIds: repoSessions.map((session) => session.id), detail: `${repoSessions.length} active sessions share ${repo.name}.` });
  }
  const byFile = new Map<string, FileClaim[]>();
  for (const claim of claims) {
    const key = `${claim.repo}\0${claim.file}`;
    byFile.set(key, [...(byFile.get(key) ?? []), claim]);
  }
  for (const fileClaims of byFile.values()) {
    const agents = [...new Set(fileClaims.map((claim) => claim.agent))];
    if (agents.length < 2) continue;
    const first = fileClaims[0]!;
    const repoId = repos.find((repo) => repo.id === first.repo || repo.path === first.repo)?.id ?? first.repo;
    conflicts.push({ kind: 'file_overlap', repoId, sessionIds: active.filter((session) => session.repoId === repoId && agents.some((agent) => agent.startsWith(`${session.agent}:`))).map((session) => session.id), files: [first.file], detail: `${agents.join(' and ')} both claim ${first.file}.` });
  }
  for (const repo of repos) {
    const repoSessions = active.filter((session) => session.repoId === repo.id);
    if (repo.isDirty && repoSessions.length > 1) conflicts.push({ kind: 'dirty_tree', repoId: repo.id, sessionIds: repoSessions.map((session) => session.id), files: repo.dirtyFiles, detail: `${repo.name} is dirty while ${repoSessions.length} sessions are active.` });
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const unmet = (task.dependsOn ?? []).filter((id) => taskById.get(id)?.status !== 'done');
    const taskSessions = active.filter((session) => session.taskId === task.id || task.sessionIds.includes(session.id));
    if (unmet.length && taskSessions.length) conflicts.push({ kind: 'dependency_wait', repoId: task.repoId ?? taskSessions[0]?.repoId ?? 'unassigned', sessionIds: taskSessions.map((session) => session.id), detail: `${task.id} is waiting for ${unmet.join(', ')}.` });
  }
  return conflicts;
}
