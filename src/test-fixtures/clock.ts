// A manually-advanceable virtual clock (ticket 09 AC7): lets a test prove a
// wall-clock budget actually fires, and exactly when, without ever really
// waiting. Timers fire in fireAt order as `advance` sweeps the virtual clock
// forward; a callback that schedules another timer (or resolves a promise
// chain that does) is picked up within the same advance() if its new fireAt
// still falls within the swept range.
import type { Clock, TimerHandle } from '../work-engine/clock.js';

export interface FakeClock extends Clock {
  /** Moves the virtual clock forward by `ms`, firing every timer due at or before the new time, in fireAt order. */
  advance(ms: number): Promise<void>;
}

export function createFakeClock(startMs = 0): FakeClock {
  let currentMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; callback: () => void }>();

  return {
    now: () => currentMs,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { fireAt: currentMs + Math.max(ms, 0), callback });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    async advance(ms) {
      const target = currentMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.fireAt <= target)
          .sort((a, b) => a[1].fireAt - b[1].fireAt)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        currentMs = timer.fireAt;
        timer.callback();
        // Let whatever the callback triggered (a resolved promise chain that
        // schedules its own follow-up timer) settle before checking again —
        // a synchronous re-scan would miss a timer scheduled from a
        // microtask the callback merely kicked off.
        await Promise.resolve();
        await Promise.resolve();
      }
      currentMs = target;
    },
  };
}
