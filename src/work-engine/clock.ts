// Ticket 09: a controllable clock — the seam that lets a hard wall-clock
// budget be enforced deterministically in tests (AC7) instead of via real
// waiting. Production code always uses systemClock; tests inject a fake
// (test-fixtures/clock.ts) that fires timers on demand.
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
