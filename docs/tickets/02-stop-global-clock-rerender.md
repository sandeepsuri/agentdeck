# 02: Stop the workspace re-rendering on a global clock

**What to build:** An idle workspace stops re-rendering everything once a second. Elapsed-time displays continue to tick as before.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Elapsed times still update once per second
- [ ] The workspace tree does not re-render on a global timer; only the components displaying elapsed time update
- [ ] No visible stutter when idle with several sessions listed
