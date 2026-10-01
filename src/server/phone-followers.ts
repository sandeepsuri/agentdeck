// Phone work: which Sessions the paired owner phone has open right now, so
// the Mac's Conversation view can say "Phone is following this session".
// In memory only; a Session counts as followed for a short while after the
// phone last read it, the way the phone polls.
const FOLLOW_WINDOW_MS = 10_000;

export class PhoneFollowers {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  touch(sessionId: string): void {
    this.seen.set(sessionId, this.now());
  }

  isFollowing(sessionId: string): boolean {
    const at = this.seen.get(sessionId);
    if (at === undefined) return false;
    if (this.now() - at <= FOLLOW_WINDOW_MS) return true;
    this.seen.delete(sessionId);
    return false;
  }
}
