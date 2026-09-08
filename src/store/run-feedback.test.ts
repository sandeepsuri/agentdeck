// Persistence for durable Task/Run feedback (docs/specs/run-feedback-review.md,
// B07). Its own file, sibling to session-chat.test.ts, for the same reason:
// a focused home for this storage seam rather than growing store.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, Store } from './index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-store-feedback-'));
  store = openStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendRunFeedback / listRunFeedback', () => {
  it('assigns a monotonic sequence per Task, starting at 1', () => {
    const first = store.appendRunFeedback({
      id: 'fb-1', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:00.000Z',
      principalId: 'local:alice', displayName: 'Alice', text: 'Should this touch auth too?',
    });
    const second = store.appendRunFeedback({
      id: 'fb-2', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:01.000Z',
      principalId: 'local:bob', displayName: 'Bob', text: 'Good question',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it('keeps sequences independent per Task', () => {
    store.appendRunFeedback({
      id: 'a-1', taskId: 'task-a', runId: 'run-a', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Alice', text: 'in A',
    });
    const first = store.appendRunFeedback({
      id: 'b-1', taskId: 'task-b', runId: 'run-b', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Bob', text: 'in B',
    });

    expect(first.sequence).toBe(1);
  });

  it('reads a Task’s feedback back in post order', () => {
    store.appendRunFeedback({
      id: 'fb-1', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Alice', text: 'first',
    });
    store.appendRunFeedback({
      id: 'fb-2', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:01.000Z', displayName: 'Bob', text: 'second',
    });

    expect(store.listRunFeedback('task-1').map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  it('never mixes one Task’s feedback into another’s', () => {
    store.appendRunFeedback({
      id: 'a-1', taskId: 'task-a', runId: 'run-a', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Alice', text: 'in A',
    });
    store.appendRunFeedback({
      id: 'b-1', taskId: 'task-b', runId: 'run-b', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Bob', text: 'in B',
    });

    expect(store.listRunFeedback('task-a').map((entry) => entry.text)).toEqual(['in A']);
  });

  it('stays addressable under the same Task across a different Run id — the reason feedback is keyed by taskId, not runId', () => {
    store.appendRunFeedback({
      id: 'fb-1', taskId: 'task-1', runId: 'run-1-first-attempt', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Alice', text: 'first attempt failed',
    });
    store.appendRunFeedback({
      id: 'fb-2', taskId: 'task-1', runId: 'run-1-retry', postedAt: '2026-09-08T00:00:01.000Z', displayName: 'Alice', text: 'retry looks better',
    });

    const entries = store.listRunFeedback('task-1');
    expect(entries.map((entry) => entry.runId)).toEqual(['run-1-first-attempt', 'run-1-retry']);
  });

  it('omits principalId for the legacy shared-token path, exactly like session chat', () => {
    const entry = store.appendRunFeedback({
      id: 'fb-1', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Shared access', text: 'anonymous note',
    });

    expect(entry.principalId).toBeUndefined();
    expect(store.listRunFeedback('task-1')[0]!.principalId).toBeUndefined();
  });

  it('survives a reopen of the same database file', () => {
    store.appendRunFeedback({
      id: 'fb-1', taskId: 'task-1', runId: 'run-1', postedAt: '2026-09-08T00:00:00.000Z', displayName: 'Alice', text: 'hello',
    });
    store.close();

    store = openStore(dir);

    expect(store.listRunFeedback('task-1').map((entry) => entry.text)).toEqual(['hello']);
  });
});
