# 08: Push Mission Control tile previews over the WebSocket

**What to build:** Mission Control tiles update from pushed output instead of each tile polling its own endpoint.

**Blocked by:** 01 (Extract SessionTranscript) — tile previews are sourced from the transcript module's subscription

**Status:** ready-for-agent

- [ ] Tiles show recent output and update live
- [ ] No per-tile HTTP polling occurs while Mission Control is open
- [ ] Adding more sessions does not multiply request volume
- [ ] Tiles for external sessions continue to show their existing placeholder
