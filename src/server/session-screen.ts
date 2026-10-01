// Phone work: the Terminal toggle's live text for a phone that has no
// WebSocket. It reuses LiveReflow, the same text-only rendering remote
// WebSocket viewers get (never raw PTY bytes), and serves it as a long-poll
// shaped like the shared window's frames: ask with the last sequence seen,
// get the next text once it changes or the wait ends.
//
// A session is rendered only while a phone keeps asking: each request
// renews a short lease, and when it lapses the LiveReflow subscription (and
// with it the render timer) ends.
import { LiveReflow, type LiveReflowOptions } from '../sessions/live-reflow.js';

/** Keeps a screen inside one relay frame with room to spare. */
export const MAX_SCREEN_CHARS = 200_000;
const LEASE_MS = 10_000;
const MAX_WAIT_MS = 2_000;

export interface ScreenSnapshot {
  seq: number;
  text: string;
}

interface Feed {
  seq: number;
  text: string;
  waiters: Set<() => void>;
  unsubscribe: () => void;
  lease: NodeJS.Timeout;
}

export class SessionScreens {
  private readonly reflow: LiveReflow;
  private readonly feeds = new Map<string, Feed>();

  constructor(getTranscript: ConstructorParameters<typeof LiveReflow>[0], opts: LiveReflowOptions = {}) {
    this.reflow = new LiveReflow(getTranscript, opts);
  }

  /** The text after `after`, waiting up to `waitMs` for a change. */
  async next(sessionId: string, after: number, waitMs: number): Promise<ScreenSnapshot> {
    const feed = this.feed(sessionId);
    // Nothing is rendered yet on a first request, so it waits for that too.
    if (feed.seq <= Math.max(after, 0) && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); feed.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(waitMs, MAX_WAIT_MS));
        feed.waiters.add(done);
      });
    }
    return { seq: feed.seq, text: feed.text };
  }

  shutdown(): void {
    for (const sessionId of [...this.feeds.keys()]) this.end(sessionId);
  }

  private feed(sessionId: string): Feed {
    const existing = this.feeds.get(sessionId);
    if (existing) {
      existing.lease.refresh();
      return existing;
    }
    const feed: Feed = {
      seq: 0, text: '', waiters: new Set(),
      unsubscribe: () => undefined,
      lease: setTimeout(() => this.end(sessionId), LEASE_MS),
    };
    feed.lease.unref?.();
    this.feeds.set(sessionId, feed);
    feed.unsubscribe = this.reflow.attach(sessionId, (rendered) => {
      const text = tail(rendered.replace(/\s+$/, ''));
      if (text === feed.text) return;
      feed.text = text;
      feed.seq += 1;
      for (const wake of [...feed.waiters]) wake();
    });
    return feed;
  }

  private end(sessionId: string): void {
    const feed = this.feeds.get(sessionId);
    if (!feed) return;
    clearTimeout(feed.lease);
    feed.unsubscribe();
    for (const wake of [...feed.waiters]) wake();
    this.feeds.delete(sessionId);
  }
}

/** The end of the text, where the live prompt is. */
export function tail(text: string): string {
  return text.length > MAX_SCREEN_CHARS ? text.slice(text.length - MAX_SCREEN_CHARS) : text;
}
