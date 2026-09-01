import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_EVENT_ENVELOPE_SCHEMA_VERSION, buildAttemptEventEnvelope, classifyEventDurability,
} from './durable-events.js';
import type { AttemptEvent } from './types.js';

describe('classifyEventDurability', () => {
  it('classifies every current AttemptEvent kind as durable', () => {
    const kinds: AttemptEvent['kind'][] = ['lifecycle', 'message', 'tool-activity', 'usage', 'completion', 'failure'];
    for (const kind of kinds) expect(classifyEventDurability(kind)).toBe('durable');
  });

  it('classifies any kind outside the shared AttemptEvent shape as transient (e.g. a future message-delta stream)', () => {
    expect(classifyEventDurability('message-delta' as AttemptEvent['kind'])).toBe('transient');
  });
});

describe('buildAttemptEventEnvelope', () => {
  const event: AttemptEvent = {
    kind: 'message', sequence: 3, at: '2026-09-01T00:00:03.000Z', role: 'assistant', text: 'Added the missing test.',
  };

  it('carries Run, Attempt, ordering, correlation, timestamp, version, and durability class', () => {
    const envelope = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event });

    expect(envelope).toMatchObject({
      runId: 'run-1',
      attemptId: 'attempt-1',
      sequence: 3,
      correlationId: 'run-1:attempt-1',
      at: '2026-09-01T00:00:03.000Z',
      schemaVersion: ATTEMPT_EVENT_ENVELOPE_SCHEMA_VERSION,
      durability: 'durable',
      event,
    });
    expect(envelope.dedupeKey).toEqual(expect.any(String));
    expect(envelope.dedupeKey.length).toBeGreaterThan(0);
  });

  it('assigns the same dedupe key to the same logical event replayed with a fresh sequence and timestamp', () => {
    const replayed: AttemptEvent = { ...event, sequence: 99, at: '2026-09-01T00:05:00.000Z' };

    const first = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event });
    const second = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event: replayed });

    expect(second.dedupeKey).toBe(first.dedupeKey);
  });

  it('assigns different dedupe keys to genuinely different event content', () => {
    const other: AttemptEvent = { ...event, text: 'A different message entirely.' };

    const first = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event });
    const second = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event: other });

    expect(second.dedupeKey).not.toBe(first.dedupeKey);
  });

  it('scopes the dedupe key to its own Attempt, so identical content in a different Attempt never collides', () => {
    const first = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event });
    const second = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-2', event });

    expect(second.dedupeKey).not.toBe(first.dedupeKey);
  });

  it('strips any field outside the shared AttemptEvent shape before it reaches the envelope (ticket 06 AC8 defense in depth)', () => {
    const leaky = {
      ...event, threadId: 'thread-should-never-persist', apiKey: 'sk-should-never-persist',
    } as unknown as AttemptEvent;

    const envelope = buildAttemptEventEnvelope({ runId: 'run-1', attemptId: 'attempt-1', event: leaky });

    expect(JSON.stringify(envelope)).not.toContain('should-never-persist');
    expect(envelope.event).toEqual(event);
  });
});
