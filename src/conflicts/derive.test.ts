import { describe, expect, it } from 'vitest';
import type { FileClaim, Repo, Session, Task } from '../types.js';
import { deriveConflicts } from './derive.js';

const repo: Repo = { id: '/repo', path: '/repo', name: 'repo', isDirty: true };
const session = (id: string, agent: 'claude' | 'codex', taskId?: string): Session => ({
  id, agent, taskId, repoId: '/repo', cwd: '/repo', origin: 'external',
  startedAt: '2026-07-17T00:00:00.000Z', lastActivityAt: '2026-07-17T00:00:00.000Z',
  status: 'working', statusSource: 'cpu_heuristic',
});
const sessions = [session('s1', 'claude', 'FE-5'), session('s2', 'codex')];

describe('deriveConflicts', () => {
  it('derives same-repo and dirty-tree conflicts', () => {
    expect(deriveConflicts(sessions, [repo], []).map((item) => item.kind)).toEqual(['same_repo', 'dirty_tree']);
  });

  it('derives overlapping active file claims and names both agents', () => {
    const claims: FileClaim[] = [
      { repo: '/repo', file: 'src/a.ts', agent: 'claude:s1', since: 'now' },
      { repo: '/repo', file: 'src/a.ts', agent: 'codex:s2', since: 'now' },
    ];
    const overlap = deriveConflicts(sessions, [{ ...repo, isDirty: false }], claims).find((item) => item.kind === 'file_overlap');
    expect(overlap).toMatchObject({ files: ['src/a.ts'] });
    expect(overlap?.detail).toContain('claude:s1');
    expect(overlap?.detail).toContain('codex:s2');
  });

  it('derives unmet task dependencies and clears when done', () => {
    const tasks: Task[] = [
      { id: 'BE-1', title: 'API', status: 'todo', sessionIds: [] },
      { id: 'FE-5', title: 'UI', status: 'in_progress', dependsOn: ['BE-1'], sessionIds: ['s1'] },
    ];
    expect(deriveConflicts(sessions, [repo], [], tasks).some((item) => item.kind === 'dependency_wait')).toBe(true);
    tasks[0]!.status = 'done';
    expect(deriveConflicts(sessions, [repo], [], tasks).some((item) => item.kind === 'dependency_wait')).toBe(false);
  });
});
