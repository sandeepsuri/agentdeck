import { describe, expect, it } from 'vitest';
import {
  MAX_FEEDBACK_TEXT_LENGTH, listRunFeedback, postRunFeedback, type RunFeedbackEntry, type RunFeedbackStore,
} from './run-feedback.js';

function fakeStore(): RunFeedbackStore & { entries: RunFeedbackEntry[] } {
  const entries: RunFeedbackEntry[] = [];
  return {
    entries,
    appendRunFeedback(input) {
      const entry: RunFeedbackEntry = {
        id: input.id,
        taskId: input.taskId,
        runId: input.runId,
        sequence: entries.filter((e) => e.taskId === input.taskId).length + 1,
        postedAt: input.postedAt,
        ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
        displayName: input.displayName,
        text: input.text,
        ...(input.reviewDecision !== undefined ? { reviewDecision: input.reviewDecision } : {}),
      };
      entries.push(entry);
      return entry;
    },
    listRunFeedback(taskId) {
      return entries.filter((entry) => entry.taskId === taskId);
    },
  };
}

describe('postRunFeedback', () => {
  it('rejects empty text without touching the store', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice', text: '   ',
    });

    expect(result).toEqual({ ok: false, error: 'text is required' });
    expect(store.entries).toHaveLength(0);
  });

  it('rejects non-string text', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice', text: 42,
    });

    expect(result).toEqual({ ok: false, error: 'text is required' });
  });

  it('rejects text longer than the maximum', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice',
      text: 'a'.repeat(MAX_FEEDBACK_TEXT_LENGTH + 1),
    });

    expect(result).toEqual({ ok: false, error: 'text is too long' });
    expect(store.entries).toHaveLength(0);
  });

  it('trims surrounding whitespace before storing', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice', text: '  looks good  ',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.text).toBe('looks good');
  });

  it('attributes the entry to the given identity, never a caller-supplied name', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice', text: 'hi',
    });

    expect(result.ok && result.entry.principalId).toBe('local:alice');
    expect(result.ok && result.entry.displayName).toBe('Alice');
  });

  it('omits principalId when none is given (legacy shared-token path)', () => {
    const store = fakeStore();
    const result = postRunFeedback(store, {
      taskId: 'task-1', runId: 'run-1', displayName: 'Shared access', text: 'hi',
    });

    expect(result.ok && result.entry.principalId).toBeUndefined();
  });

  // Ticket 71 (B09): a review decision is the same durable row, one more
  // validated field — never a second write path.
  describe('reviewDecision (ticket 71, B09)', () => {
    it('accepts and stores a valid reviewDecision', () => {
      const store = fakeStore();
      const result = postRunFeedback(store, {
        taskId: 'task-1', runId: 'run-1', displayName: 'Alice', text: 'Please add a test', reviewDecision: 'changes_requested',
      });

      expect(result.ok && result.entry.reviewDecision).toBe('changes_requested');
    });

    it('rejects an invalid reviewDecision value, without touching the store', () => {
      const store = fakeStore();
      const result = postRunFeedback(store, {
        taskId: 'task-1', runId: 'run-1', displayName: 'Alice', text: 'hi', reviewDecision: 'approved' as never,
      });

      expect(result).toEqual({ ok: false, error: 'reviewDecision must be "changes_requested" or "reviewed"' });
      expect(store.entries).toHaveLength(0);
    });

    it('still requires non-empty text for a review decision — the same rule as an ordinary comment', () => {
      const store = fakeStore();
      const result = postRunFeedback(store, {
        taskId: 'task-1', runId: 'run-1', displayName: 'Alice', text: '   ', reviewDecision: 'reviewed',
      });

      expect(result).toEqual({ ok: false, error: 'text is required' });
    });

    it('omits reviewDecision for an ordinary comment', () => {
      const store = fakeStore();
      const result = postRunFeedback(store, { taskId: 'task-1', runId: 'run-1', displayName: 'Alice', text: 'just a note' });

      expect(result.ok && result.entry.reviewDecision).toBeUndefined();
    });
  });
});

describe('listRunFeedback', () => {
  it('returns the store’s entries for the given Task unchanged', () => {
    const store = fakeStore();
    postRunFeedback(store, { taskId: 'task-1', runId: 'run-1', principalId: 'local:alice', displayName: 'Alice', text: 'first' });
    postRunFeedback(store, { taskId: 'task-1', runId: 'run-1', principalId: 'local:bob', displayName: 'Bob', text: 'second' });
    postRunFeedback(store, { taskId: 'task-2', runId: 'run-2', principalId: 'local:alice', displayName: 'Alice', text: 'other task' });

    expect(listRunFeedback(store, 'task-1').map((entry) => entry.text)).toEqual(['first', 'second']);
  });
});
