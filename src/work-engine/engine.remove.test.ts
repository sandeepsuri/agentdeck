// remove() never touches a worktree, an adapter, or verification — it is a
// pure store operation guarded by policy and terminal status — so these
// tests seed Run rows directly through the Store rather than driving the
// full prepare/start/verify pipeline other engine.test.ts suites exercise.
import { describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { DurableWorkEngine, InvalidRunStateError, PolicyDeniedError, RunNotFoundError } from './engine.js';
import type { RunActor, RunRepository, RunStatus, WorkSpec } from './types.js';

const repository: RunRepository = { id: 'repo-1', name: 'example', path: '/tmp/example' };

const spec: WorkSpec = {
  objective: 'Delete me',
  acceptanceCriteria: ['It is deleted'],
  repository,
  requestedBaseReference: 'main',
  runtimePreference: ['codex'],
  budget: {},
  verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'working-tree',
};

function seedRun(store: Store, runId: string, status: RunStatus) {
  store.upsertRepo(repository);
  store.createTaskAndRun(
    { id: `task-${runId}`, title: spec.objective, status: 'todo', sessionIds: [] },
    {
      id: runId,
      taskId: `task-${runId}`,
      status,
      spec,
      submittedAt: '2026-09-01T00:00:00.000Z',
      principal: { id: 'local:test', displayName: 'test' },
      preparation: { state: 'pending' },
      envelope: { state: 'pending' },
      verificationPolicy: { state: 'pending' },
      attempt: { state: 'idle' },
    },
  );
}

describe('DurableWorkEngine.remove', () => {
  it.each<RunStatus>(['completed', 'completed_unverified', 'failed_verification', 'failed_budget', 'failed', 'cancelled'])(
    'permanently deletes a Run whose status is terminal: %s',
    async (status) => {
      const store = new Store(':memory:');
      const engine = new DurableWorkEngine(store);
      seedRun(store, 'run-1', status);
      await engine.remove('run-1');
      expect(engine.get('run-1')).toBeUndefined();
      expect(store.listRuns()).toEqual([]);
    },
  );

  it('refuses to delete a Run that is still in progress, leaving it exactly as it was', async () => {
    const store = new Store(':memory:');
    const engine = new DurableWorkEngine(store);
    seedRun(store, 'run-running', 'running');
    await expect(engine.remove('run-running')).rejects.toThrow(InvalidRunStateError);
    expect(engine.get('run-running')).toBeDefined();
  });

  it('rejects deleting an unknown Run', async () => {
    const store = new Store(':memory:');
    const engine = new DurableWorkEngine(store);
    await expect(engine.remove('does-not-exist')).rejects.toThrow(RunNotFoundError);
  });

  it('refuses every collaborator actor — admin-only, exactly like publish', async () => {
    const store = new Store(':memory:');
    const engine = new DurableWorkEngine(store);
    seedRun(store, 'run-2', 'completed');
    const collaboratorActor: RunActor = {
      principal: { id: 'collab-1', displayName: 'Collaborator' },
      grants: { repositoryIds: [repository.id], profileIds: [] },
    };
    await expect(engine.remove('run-2', collaboratorActor)).rejects.toThrow(PolicyDeniedError);
    expect(engine.get('run-2')).toBeDefined();
  });
});
