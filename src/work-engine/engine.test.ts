import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { DurableWorkEngine } from './engine.js';
import type { WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-work-engine-'));
  tempDirectories.push(directory);
  return path.join(directory, 'agentdeck.db');
}

function workSpec(): WorkSpec {
  return {
    objective: 'Add durable managed work',
    acceptanceCriteria: [
      'The queued run survives restart',
      'The submitted intent is unchanged',
    ],
    repository: {
      id: '/repos/agentdeck',
      name: 'agentdeck',
      path: '/repos/agentdeck',
    },
    requestedBaseReference: 'refs/heads/main',
    runtimePreference: ['codex', 'claude'],
    budget: {
      maxWallClockMs: 3_600_000,
      maxModelTurns: 40,
      maxToolCalls: 200,
    },
    verificationIntent: {
      required: true,
      commands: ['npm test', 'npm run typecheck'],
    },
    requestedDeliveryResult: 'local-commit',
  };
}

function registerRepository(store: Store): void {
  store.upsertRepo({ id: '/repos/agentdeck', name: 'agentdeck', path: '/repos/agentdeck' });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('DurableWorkEngine', () => {
  it('submits one objective as a durable task and queued run with frozen intent', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();

    const run = await engine.submit(submitted);

    expect(run).toMatchObject({
      taskId: expect.any(String),
      id: expect.any(String),
      status: 'queued',
      spec: submitted,
      submittedAt: expect.any(String),
    });
    expect(engine.get(run.id)).toEqual(run);
    expect(engine.list()).toEqual([run]);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.spec)).toBe(true);
    expect(Object.isFrozen(run.spec.acceptanceCriteria)).toBe(true);

    store.close();
  });

  it('reopens the same queued run and submitted intent after the store restarts', async () => {
    const dbPath = databasePath();
    const firstStore = new Store(dbPath);
    registerRepository(firstStore);
    const submitted = workSpec();
    const created = await new DurableWorkEngine(firstStore).submit(submitted);
    firstStore.close();

    const reopenedStore = new Store(dbPath);
    const reopened = new DurableWorkEngine(reopenedStore).get(created.id);

    expect(reopened).toEqual(created);
    expect(reopened?.id).toBe(created.id);
    expect(reopened?.taskId).toBe(created.taskId);
    expect(reopened?.status).toBe('queued');
    expect(reopened?.spec).toEqual(submitted);
    reopenedStore.close();
  });

  it('copies submitted values so caller mutation cannot rewrite the frozen run', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();
    const run = await engine.submit(submitted);

    submitted.acceptanceCriteria.push('A later caller mutation');
    submitted.repository.name = 'renamed-after-submit';
    submitted.runtimePreference.reverse();

    expect(engine.get(run.id)?.spec).toEqual(workSpec());
    store.close();
  });

  it('rejects incomplete intent before creating a run', async () => {
    const store = new Store(':memory:');
    registerRepository(store);
    const engine = new DurableWorkEngine(store);
    const submitted = workSpec();
    submitted.acceptanceCriteria = [];

    await expect(engine.submit(submitted)).rejects.toThrow('acceptanceCriteria');
    expect(engine.list()).toEqual([]);
    store.close();
  });

  it('rejects a Repository outside AgentDeck\'s known repository boundary', async () => {
    const store = new Store(':memory:');
    const engine = new DurableWorkEngine(store);

    await expect(engine.submit(workSpec())).rejects.toThrow('repository is not known');
    expect(engine.list()).toEqual([]);
    store.close();
  });
});
