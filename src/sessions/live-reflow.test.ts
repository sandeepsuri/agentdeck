import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveReflow } from './live-reflow.js';

function fakeTranscript(text: string) {
  return { snapshot: () => text };
}

describe('LiveReflow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does no rendering work when nothing has attached (no timer, no render call)', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const getTranscript = vi.fn(() => fakeTranscript('hello'));
    const unused = new LiveReflow(getTranscript, { render, intervalMs: 1000 });
    void unused;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(render).not.toHaveBeenCalled();
    expect(getTranscript).not.toHaveBeenCalled();
  });

  it('attach starts a timer and fires an immediate frame without waiting a full interval', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const live = new LiveReflow(() => fakeTranscript('hello'), { render, intervalMs: 1000 });
    const received: string[] = [];

    live.attach('s1', (text) => received.push(text));
    await vi.advanceTimersByTimeAsync(0);

    expect(render).toHaveBeenCalledTimes(1);
    expect(received).toEqual(['rendered:hello']);
  });

  it('a second concurrent attach on the same session does not start a second timer', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const live = new LiveReflow(() => fakeTranscript('hello'), { render, intervalMs: 1000 });

    live.attach('s1', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    render.mockClear();

    const received: string[] = [];
    live.attach('s1', (text) => received.push(text));
    // The late joiner gets the cached frame immediately, with no extra render call.
    expect(render).not.toHaveBeenCalled();
    expect(received).toEqual(['rendered:hello']);

    // Only one shared timer for the session: a single interval tick renders once, not twice.
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('the last detach clears the timer entirely; no further renders or callbacks after that', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const live = new LiveReflow(() => fakeTranscript('hello'), { render, intervalMs: 1000 });
    const received: string[] = [];

    const unsubscribe = live.attach('s1', (text) => received.push(text));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);

    unsubscribe();
    render.mockClear();
    received.length = 0;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(render).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('detaching one of several viewers keeps the shared timer running for the rest', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const live = new LiveReflow(() => fakeTranscript('hello'), { render, intervalMs: 1000 });
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const unsubscribeA = live.attach('s1', (text) => receivedA.push(text));
    live.attach('s1', (text) => receivedB.push(text));
    await vi.advanceTimersByTimeAsync(0);

    unsubscribeA();
    await vi.advanceTimersByTimeAsync(1000);

    expect(receivedA).toHaveLength(1); // nothing after unsubscribing
    expect(receivedB.length).toBeGreaterThanOrEqual(2); // still getting ticks
  });

  it('two different session ids get independent timers', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const texts: Record<string, string> = { s1: 'one', s2: 'two' };
    const live = new LiveReflow((id) => fakeTranscript(texts[id]!), { render, intervalMs: 1000 });
    const receivedS1: string[] = [];
    const receivedS2: string[] = [];

    const unsubscribeS1 = live.attach('s1', (text) => receivedS1.push(text));
    live.attach('s2', (text) => receivedS2.push(text));
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedS1).toEqual(['rendered:one']);
    expect(receivedS2).toEqual(['rendered:two']);

    unsubscribeS1();
    receivedS1.length = 0;
    receivedS2.length = 0;
    await vi.advanceTimersByTimeAsync(1000);

    expect(receivedS1).toEqual([]); // s1's timer was cleared
    expect(receivedS2).toEqual(['rendered:two']); // s2's timer is unaffected
  });

  it('a tick for a session with no live transcript is a silent no-op', async () => {
    const render = vi.fn(async (bytes: string) => `rendered:${bytes}`);
    const live = new LiveReflow(() => undefined, { render, intervalMs: 1000 });
    const received: string[] = [];

    live.attach('gone', (text) => received.push(text));
    await vi.advanceTimersByTimeAsync(0);

    expect(render).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });
});
