# 09: Persist managed session output and compact it on exit

**What to build:** An ended managed session can be reopened and read in full.

Output is written to disk while the session runs. On exit it is converted once into readable scrollback, with terminal redraw noise resolved so it reads as text rather than as overlapping repainted frames. That conversion costs no model call.

**Blocked by:** 01 (Extract SessionTranscript) — the transcript module owns the bytes this writes to disk; 04 (Keep ended managed sessions) — there must be an ended session for scrollback to belong to

**Status:** ready-for-agent

- [ ] Reopening an ended managed session shows its scrollback, readable as text
- [ ] Scrollback survives restarting the server
- [ ] A long-running session is capped on disk, keeping the most recent output rather than the oldest
- [ ] Conversion happens once, on exit, and requires no model call
- [ ] Raw output is removed once it has been converted
- [ ] A session that ends while the server is shutting down is not left unreadable
