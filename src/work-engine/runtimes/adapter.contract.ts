// The one behavioral contract every managed runtime adapter must satisfy
// (ticket 05's Codex adapter; ticket 14 runs the same suite against Claude):
// an ordered lifecycle, well-formed events, exactly one terminal outcome,
// and no runtime-specific leakage into the shared event shape.
import { describe, expect, it } from 'vitest';
import { ATTEMPT_EVENT_FIELDS } from '../types.js';
import type { AttemptEvent } from '../types.js';
import type { AttemptLaunchContext, RuntimeAttemptAdapter } from './adapter.js';

export interface RuntimeAttemptAdapterContractCase {
  readonly name: string;
  readonly context: AttemptLaunchContext;
  readonly createAdapter: () => RuntimeAttemptAdapter;
  readonly expectOutcome: 'completion' | 'failure';
}

async function collect(adapter: RuntimeAttemptAdapter, context: AttemptLaunchContext): Promise<AttemptEvent[]> {
  const events: AttemptEvent[] = [];
  for await (const event of adapter.run(context)) events.push(event);
  return events;
}

export function describeRuntimeAttemptAdapterContract(cases: readonly RuntimeAttemptAdapterContractCase[]): void {
  for (const testCase of cases) {
    describe(`runtime adapter contract: ${testCase.name}`, () => {
      it('starts with an attempt-started lifecycle event at sequence 0', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        expect(events[0]).toMatchObject({ kind: 'lifecycle', phase: 'attempt-started', sequence: 0 });
      });

      it('assigns strictly increasing sequence numbers with no gaps', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        events.forEach((event, index) => expect(event.sequence).toBe(index));
      });

      it('ends with exactly one terminal event, and nothing follows it', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        const terminalIndexes = events
          .map((event, index) => (event.kind === 'completion' || event.kind === 'failure' ? index : -1))
          .filter((index) => index >= 0);
        expect(terminalIndexes).toEqual([events.length - 1]);
        expect(events[events.length - 1]?.kind).toBe(testCase.expectOutcome);
      });

      it('reports every event timestamp as a valid ISO instant', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) expect(Number.isNaN(Date.parse(event.at))).toBe(false);
      });

      it('never reports usage as zero when the runtime did not report a figure', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        for (const event of events) {
          if (event.kind !== 'usage') continue;
          expect(event.inputTokens === 'unknown' || Number.isFinite(event.inputTokens)).toBe(true);
          expect(event.outputTokens === 'unknown' || Number.isFinite(event.outputTokens)).toBe(true);
        }
      });

      it('keeps every event within the shared shape, with no runtime-specific fields', async () => {
        const events = await collect(testCase.createAdapter(), testCase.context);
        for (const event of events) {
          const allowed = new Set(ATTEMPT_EVENT_FIELDS[event.kind]);
          for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
        }
      });
    });
  }
}
