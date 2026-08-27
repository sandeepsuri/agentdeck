# 01: Extract SessionTranscript and take managed session output off the persistence path

**What to build:** With several managed sessions running active agents, the workspace stays responsive. Output produced by a managed session no longer causes a database write and a workspace-wide broadcast for every chunk it emits.

Everything about a managed session's output bytes moves behind a single module: the buffer, its size cap, and the batching of updates to viewers. The session manager keeps lifecycle and status derivation; it no longer owns buffering. This module is the foundation for on-disk scrollback and the mobile reflow view later, so its interface matters more than its internals.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Typing into a managed session echoes without perceptible delay while four managed sessions are producing output
- [ ] Switching between managed sessions is immediate
- [ ] The workspace does not visibly stutter while managed sessions run and nobody is interacting
- [ ] Session output no longer causes a database write per chunk; status changes still persist immediately
- [ ] Last-activity time may lag by up to a second — nothing user-visible depends on finer freshness
- [ ] Updates to viewers are batched rather than sent per chunk
- [ ] Existing session manager tests pass, and the new module is tested through its own interface
