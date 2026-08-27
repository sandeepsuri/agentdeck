# 07: Keep managed session terminal views alive across switches

**What to build:** Switching between managed sessions is instant, with no flash of cleared or redrawn output. A session's terminal view persists while the session is live rather than being destroyed and rebuilt on every switch.

**Blocked by:** 03 (Pin managed session terminal size) — persistent views will fight over the size unless it is already fixed

**Status:** ready-for-agent

- [ ] Switching to a previously viewed session shows its output immediately, with no clear-and-replay flash
- [ ] Scroll position within a session's terminal is preserved across switching away and back
- [ ] Views are torn down when their session ends or is removed, not on every switch
- [ ] Memory does not grow unbounded as sessions are opened and closed over a long working day
