// SessionTranscript: owns everything about the bytes a managed session
// produces. Replaces direct RingBuffer usage in SessionManager and moves the
// per-chunk fan-out to viewers into a single coalesced timer, so a spinner
// animating at 10-30 chunks/sec doesn't turn into 10-30 WS messages/sec (or,
// before this module existed, 10-30 synchronous sqlite writes/sec) per
// session. See docs/specs/session-persistence-and-remote-access.md
// ("SessionTranscript" under Module design).
import { RingBuffer } from './ringbuffer.js';

export type Unsubscribe = () => void;

export interface SessionTranscriptOptions {
  /** ring buffer capacity per session (bytes-ish; string length) */
  capacity?: number;
  /** batching window for subscribe() callbacks, ms */
  coalesceMs?: number;
}

const DEFAULT_CAPACITY = 64 * 1024;
const DEFAULT_COALESCE_MS = 16;

/**
 * Bounded record of a session's raw output, plus a coalesced fan-out to
 * subscribers (viewing WebSocket sockets). `append` is the hot path — it
 * must stay cheap and synchronous. `subscribe` callbacks fire on a timer,
 * not on every `append`.
 */
export class SessionTranscript {
  private buffer: RingBuffer;
  private readonly coalesceMs: number;
  private subscribers = new Set<(data: string) => void>();
  private pending = '';
  private timer?: NodeJS.Timeout;

  constructor(opts: SessionTranscriptOptions = {}) {
    this.buffer = new RingBuffer(opts.capacity ?? DEFAULT_CAPACITY);
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  /** Record a chunk of output. Cheap: a ring-buffer push plus a string concat. */
  append(data: string): void {
    if (data === '') return;
    this.buffer.push(data);
    this.pending += data;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
      // Never hold the process open just to deliver a terminal batch.
      this.timer.unref?.();
    }
  }

  /** Full buffered output, for replay when a viewer (re)attaches. */
  snapshot(): string {
    return this.buffer.snapshot();
  }

  /** Subscribe to coalesced output batches. Returns an unsubscribe function. */
  subscribe(cb: (data: string) => void): Unsubscribe {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Tear down the buffer and any pending timer/subscribers. Stage 1 scope
   * only — no disk spill or compaction here yet (that's ScrollbackRenderer,
   * tickets 09/10).
   */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    this.subscribers.clear();
    this.buffer.clear();
  }

  private flush(): void {
    this.timer = undefined;
    if (this.pending === '') return;
    const batch = this.pending;
    this.pending = '';
    for (const cb of this.subscribers) cb(batch);
  }
}
