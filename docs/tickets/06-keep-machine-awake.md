# 06: Keep the machine awake while managed sessions are live

**What to build:** The machine stays awake while managed sessions are live, so closing the lid does not strand a remote viewer.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] While at least one managed session is live, the machine does not sleep
- [ ] The assertion is released when the last managed session ends
- [ ] Closing the lid with a managed session running leaves the workspace reachable remotely
