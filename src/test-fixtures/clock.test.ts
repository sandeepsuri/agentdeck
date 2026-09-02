import { describe, expect, it } from 'vitest';
import { createFakeClock } from './clock.js';

describe('createFakeClock', () => {
  it('never advances on its own — now() stays put until advance() is called', () => {
    const clock = createFakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it('fires a timer once advance() sweeps past its fireAt, and not before', async () => {
    const clock = createFakeClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, 100);

    await clock.advance(50);
    expect(fired).toBe(false);
    expect(clock.now()).toBe(50);

    await clock.advance(50);
    expect(fired).toBe(true);
    expect(clock.now()).toBe(100);
  });

  it('fires multiple due timers in fireAt order within one advance()', async () => {
    const clock = createFakeClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('second'), 200);
    clock.setTimeout(() => order.push('first'), 100);

    await clock.advance(300);

    expect(order).toEqual(['first', 'second']);
  });

  it('never fires a cleared timer', async () => {
    const clock = createFakeClock();
    let fired = false;
    const handle = clock.setTimeout(() => { fired = true; }, 100);
    clock.clearTimeout(handle);

    await clock.advance(200);

    expect(fired).toBe(false);
  });

  it('fires a timer a callback schedules from inside another firing callback, within the same advance()', async () => {
    const clock = createFakeClock();
    const order: string[] = [];
    clock.setTimeout(() => {
      order.push('first');
      clock.setTimeout(() => order.push('chained'), 10);
    }, 100);

    await clock.advance(150);

    expect(order).toEqual(['first', 'chained']);
  });
});
