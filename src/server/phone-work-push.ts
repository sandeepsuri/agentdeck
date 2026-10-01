// Phone work: a content-free push to the owner's phones when a Session or
// Run starts waiting on them (an approval, a question, Run attention, or a
// result ready to review). The push says only that something is waiting;
// the phone fetches what over its own encrypted channel. Each waiting item
// is pushed once, however long it waits.
import { deriveNeeds, pushWorthy, type WorkState } from './phone-work.js';

const INTERVAL_MS = 4_000;

export function watchWorkNeeds(options: {
  state: () => WorkState;
  push: () => void;
  intervalMs?: number;
}): () => void {
  const waiting = () => new Set(deriveNeeds(options.state()).filter(pushWorthy).map((need) => need.id));
  let seen: Set<string>;
  try { seen = waiting(); } catch { seen = new Set(); }
  const timer = setInterval(() => {
    let current: Set<string>;
    try { current = waiting(); } catch { return; }
    const fresh = [...current].some((id) => !seen.has(id));
    seen = current;
    if (fresh) {
      try { options.push(); } catch { /* a push is best effort */ }
    }
  }, options.intervalMs ?? INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
