# 11: Summarize an ended managed session on demand

**What to build:** A wrap-up control on an ended managed session produces a summary of what that session did, stored alongside it, so it can be read before deciding whether to reopen the work.

Summarization is deliberately manual. It must never fire on its own — in particular, stopping the dev server ends every managed session at once, and those are exactly the sessions nobody wants summarized.

**Blocked by:** 09 (Persist and compact output) — there must be readable scrollback to summarize

**Status:** ready-for-agent

- [ ] Wrap-up is available on an ended session and absent on a live one
- [ ] Pressing it produces a summary within a reasonable wait, with progress shown
- [ ] The summary is stored and displayed when the session is reopened
- [ ] Running wrap-up again regenerates and replaces the summary
- [ ] Summarization never runs automatically, including when the server shuts down
- [ ] A failed summary is reported clearly and does not lose the scrollback
