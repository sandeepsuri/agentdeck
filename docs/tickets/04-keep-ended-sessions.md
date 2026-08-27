# 04: Keep ended managed sessions instead of deleting them

**What to build:** A managed session that exits stays in the workspace marked as ended, instead of disappearing.

Today an exited session's record is deleted outright. That was deliberate, and this reverses it: an ended session is the thing you reopen when you need to see what happened.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] When a managed session's process exits it remains listed, with an ended state and the time it ended
- [ ] An ended session is visually distinguishable from a live one
- [ ] Ended sessions survive a server restart
- [ ] Actions that only make sense for a live session are unavailable on an ended one
