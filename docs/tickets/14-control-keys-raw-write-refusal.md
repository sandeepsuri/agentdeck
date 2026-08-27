# 14: Control keys and raw-write refusal for remote connections

**What to build:** From a phone you can interrupt or navigate a managed session using a fixed set of control keys, while arbitrary raw input from a remote connection is refused by the server.

Free-text conversation with an agent already works from the existing composer. The gap this closes is interrupting a stuck agent and answering a prompt it has drawn. Arbitrary keystroke injection into a shell from a device that lives in a pocket is deliberately not offered.

**Blocked by:** 05 (Tailscale token authentication) — enforcement depends on connection capabilities

**Status:** ready-for-agent

- [ ] Ctrl-C, Esc, arrow keys, and Enter can be sent to a managed session from a phone
- [ ] Ctrl-C interrupts a running agent
- [ ] Free-text messages continue to work from a phone
- [ ] Raw input outside the permitted set, arriving on a remote connection, is refused by the server regardless of what the client sends
- [ ] The refusal is enforced server-side, verified by a request that bypasses the UI
- [ ] Local connections are unaffected
