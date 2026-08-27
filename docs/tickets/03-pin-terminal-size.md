# 03: Pin managed session terminal size and remove viewer resize authority

**What to build:** Managed session terminals render correctly no matter which session is selected or how large the pane is.

A managed session's terminal size is fixed for the life of the session and no viewer can change it. The terminal view letterboxes inside its pane instead. This is what makes replayed and saved output render faithfully, and what makes two simultaneous viewers possible later without them fighting over the size.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Switching repeatedly between managed sessions, in panes of different sizes, never produces misaligned or wrongly wrapped output
- [ ] A resize request from a viewer does not change the managed session's terminal size
- [ ] The terminal view letterboxes within its pane rather than reflowing
- [ ] Newly launched managed sessions use the same terminal size as before this change
