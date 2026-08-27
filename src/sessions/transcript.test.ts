import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTranscript } from './transcript.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SessionTranscript', () => {
  it('snapshot() replays everything appended, bounded by capacity like RingBuffer', () => {
    const t = new SessionTranscript({ capacity: 10 });
    t.append('aaaa');
    t.append('bbbb');
    expect(t.snapshot()).toBe('aaaabbbb');
    t.append('cccc'); // 12 > 10 → oldest whole chunk dropped
    expect(t.snapshot()).toBe('bbbbcccc');
  });

  it('coalesces multiple appends within the window into a single subscriber callback', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const received: string[] = [];
    t.subscribe((data) => received.push(data));

    t.append('a');
    t.append('b');
    t.append('c');
    expect(received).toEqual([]); // nothing delivered yet — still inside the window

    vi.advanceTimersByTime(16);
    expect(received).toEqual(['abc']); // one batch, not three
  });

  it('delivers separate batches for appends in separate windows', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const received: string[] = [];
    t.subscribe((data) => received.push(data));

    t.append('first');
    vi.advanceTimersByTime(16);
    t.append('second');
    vi.advanceTimersByTime(16);

    expect(received).toEqual(['first', 'second']);
  });

  it('does not schedule a flush, or call subscribers, when nothing was appended', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const cb = vi.fn();
    t.subscribe(cb);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further deliveries without affecting other subscribers', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = t.subscribe((data) => a.push(data));
    t.subscribe((data) => b.push(data));

    t.append('one');
    vi.advanceTimersByTime(16);
    unsubA();
    t.append('two');
    vi.advanceTimersByTime(16);

    expect(a).toEqual(['one']);
    expect(b).toEqual(['one', 'two']);
  });

  it('close() clears the buffer and stops delivering to subscribers', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const received: string[] = [];
    t.subscribe((data) => received.push(data));
    t.append('before-close');

    t.close();
    expect(t.snapshot()).toBe('');

    vi.advanceTimersByTime(1000);
    expect(received).toEqual([]); // pending batch was discarded, not flushed

    t.append('after-close');
    vi.advanceTimersByTime(1000);
    expect(t.snapshot()).toBe('after-close'); // buffer usable again
    expect(received).toEqual([]); // subscriber set was cleared by close()
  });

  it('ignores empty appends', () => {
    const t = new SessionTranscript({ coalesceMs: 16 });
    const cb = vi.fn();
    t.subscribe(cb);
    t.append('');
    vi.advanceTimersByTime(16);
    expect(cb).not.toHaveBeenCalled();
    expect(t.snapshot()).toBe('');
  });
});
