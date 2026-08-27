# 05: Reach the workspace over Tailscale with token authentication

**What to build:** The workspace can be opened from a phone on the same tailnet, gated by a token, while staying reachable on loopback exactly as before.

Whether a connection is local or remote, and what that connection is permitted to do, is decided in one place and consulted everywhere. Today the loopback check is repeated in three independent places; adding a second allowed host means all three must agree, and one of them is the content security policy — miss it and a remote client loads the page but its live connection is silently blocked.

A managed session is a shell running with the user's credentials, so this is a security surface, not a configuration change.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The workspace loads and functions from a phone on the tailnet after entering the token once
- [ ] Loopback access continues to work without a token
- [ ] The server does not listen on all interfaces
- [ ] A tailnet request without a valid token is refused
- [ ] The origin check, the WebSocket upgrade, and the content security policy all agree on which hosts are allowed, verified by a remote client holding a live connection rather than only loading the page
- [ ] The token is stored with owner-only permission and is never returned by the server or written to the database
- [ ] Connection classification carries the set of capabilities that connection is permitted, for enforcement by later tickets
