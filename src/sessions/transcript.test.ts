import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionTranscript, compactOrphanedRawLog, readScrollback } from './transcript.js';

describe('SessionTranscript coalescing (in-memory, no disk assertions)', () => {
  let sessionsDir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-transcript-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  const make = (over: Partial<ConstructorParameters<typeof SessionTranscript>[0]> = {}) =>
    new SessionTranscript({ sessionId: 's1', sessionsDir, ...over });

  it('snapshot() replays everything appended, bounded by capacity like RingBuffer', () => {
    const t = make({ capacity: 10 });
    t.append('aaaa');
    t.append('bbbb');
    expect(t.snapshot()).toBe('aaaabbbb');
    t.append('cccc'); // 12 > 10 → oldest whole chunk dropped
    expect(t.snapshot()).toBe('bbbbcccc');
  });

  it('coalesces multiple appends within the window into a single subscriber callback', () => {
    const t = make({ coalesceMs: 16 });
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
    const t = make({ coalesceMs: 16 });
    const received: string[] = [];
    t.subscribe((data) => received.push(data));

    t.append('first');
    vi.advanceTimersByTime(16);
    t.append('second');
    vi.advanceTimersByTime(16);

    expect(received).toEqual(['first', 'second']);
  });

  it('does not schedule a flush, or call subscribers, when nothing was appended', () => {
    const t = make({ coalesceMs: 16 });
    const cb = vi.fn();
    t.subscribe(cb);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further deliveries without affecting other subscribers', () => {
    const t = make({ coalesceMs: 16 });
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

  it('ignores empty appends', () => {
    const t = make({ coalesceMs: 16 });
    const cb = vi.fn();
    t.subscribe(cb);
    t.append('');
    vi.advanceTimersByTime(16);
    expect(cb).not.toHaveBeenCalled();
    expect(t.snapshot()).toBe('');
  });
});

describe('SessionTranscript disk spill, tail cap, and compaction on close()', () => {
  let sessionsDir: string;
  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-transcript-disk-'));
  });
  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  const rawLogFor = (id: string) => path.join(sessionsDir, id, 'raw.log');
  const scrollbackFor = (id: string) => path.join(sessionsDir, id, 'scrollback.txt');
  const settle = () => new Promise((r) => setTimeout(r, 40));

  it('spills appended output to raw.log on disk while the session is live', async () => {
    const t = new SessionTranscript({ sessionId: 's1', sessionsDir, coalesceMs: 5 });
    t.append('hello');
    await settle();
    expect(fs.readFileSync(rawLogFor('s1'), 'utf8')).toBe('hello');
    await t.close();
  });

  it('caps raw.log at maxRawBytes, keeping the tail rather than the oldest bytes', async () => {
    const t = new SessionTranscript({ sessionId: 's1', sessionsDir, coalesceMs: 5, maxRawBytes: 10 });
    t.append('aaaa');
    await settle();
    t.append('bbbb');
    await settle();
    t.append('cccc');
    await settle();
    // Same drop-oldest-whole-chunk semantics as RingBuffer (ringbuffer already
    // tests this in isolation) — here we assert it reaches the actual file.
    expect(fs.readFileSync(rawLogFor('s1'), 'utf8')).toBe('bbbbcccc');
    await t.close();
  });

  it('close() flushes any not-yet-coalesced output, so nothing right before exit is lost', async () => {
    const t = new SessionTranscript({ sessionId: 's1', sessionsDir, coalesceMs: 10_000 }); // never fires on its own
    t.append('right before exit');
    const { scrollbackPath } = await t.close();
    expect(fs.readFileSync(scrollbackPath, 'utf8')).toBe('right before exit');
  });

  it('close() compacts via ScrollbackRenderer into scrollback.txt and deletes raw.log — once, no model call', async () => {
    const t = new SessionTranscript({ sessionId: 's1', sessionsDir, coalesceMs: 5, cols: 40 });
    t.append('hello world');
    await settle();
    expect(fs.existsSync(rawLogFor('s1'))).toBe(true);

    const { scrollbackPath } = await t.close();
    expect(scrollbackPath).toBe(scrollbackFor('s1'));
    expect(fs.readFileSync(scrollbackPath, 'utf8')).toBe('hello world');
    expect(fs.existsSync(rawLogFor('s1'))).toBe(false); // raw deleted once converted
  });

  it('readScrollback reads back what close() wrote, independent of the transcript instance', async () => {
    const t = new SessionTranscript({ sessionId: 's1', sessionsDir, coalesceMs: 5 });
    t.append('persisted output');
    await t.close();
    expect(await readScrollback(sessionsDir, 's1')).toBe('persisted output');
  });

  it('readScrollback returns undefined when nothing has been compacted for that session', async () => {
    expect(await readScrollback(sessionsDir, 'never-existed')).toBeUndefined();
  });

  it('compactOrphanedRawLog compacts a raw.log left behind with no live transcript (hard-kill recovery)', async () => {
    fs.mkdirSync(path.join(sessionsDir, 's1'), { recursive: true });
    fs.writeFileSync(rawLogFor('s1'), 'orphaned output');

    const result = await compactOrphanedRawLog(sessionsDir, 's1', 40);
    expect(result?.scrollbackPath).toBe(scrollbackFor('s1'));
    expect(fs.readFileSync(scrollbackFor('s1'), 'utf8')).toBe('orphaned output');
    expect(fs.existsSync(rawLogFor('s1'))).toBe(false);
  });

  it('compactOrphanedRawLog is a no-op when there is no raw.log for that session', async () => {
    expect(await compactOrphanedRawLog(sessionsDir, 'no-such-session')).toBeUndefined();
  });
});
