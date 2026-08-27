# Tickets: Session Persistence and Remote Access

Vertical slices derived from [the spec](../specs/session-persistence-and-remote-access.md).
Each ticket is demoable on its own and sized for a single working session.

Numbering is dependency order — blockers before the tickets they gate.

## Startable now

| # | Ticket |
|---|---|
| 01 | [Extract SessionTranscript, take output off the persistence path](01-extract-session-transcript.md) |
| 02 | [Stop the workspace re-rendering on a global clock](02-stop-global-clock-rerender.md) |
| 03 | [Pin managed session terminal size](03-pin-terminal-size.md) |
| 04 | [Keep ended managed sessions instead of deleting them](04-keep-ended-sessions.md) |
| 05 | [Reach the workspace over Tailscale with token authentication](05-tailscale-token-auth.md) |
| 06 | [Keep the machine awake while managed sessions are live](06-keep-machine-awake.md) |

## Gated

| # | Ticket | Blocked by |
|---|---|---|
| 07 | [Keep terminal views alive across switches](07-keep-terminal-views-alive.md) | 03 |
| 08 | [Push Mission Control tile previews over the WebSocket](08-push-tile-previews.md) | 01 |
| 09 | [Persist managed session output and compact it on exit](09-persist-and-compact-output.md) | 01, 04 |
| 10 | [History view for ended managed sessions](10-history-view.md) | 04, 09 |
| 11 | [Summarize an ended managed session on demand](11-summarize-on-demand.md) | 09 |
| 12 | [Choose the summary model from a fetched catalog](12-summary-model-catalog.md) | 11 |
| 13 | [Reflowed session view on mobile](13-mobile-reflow-view.md) | 05, 09 |
| 14 | [Control keys and raw-write refusal for remote connections](14-control-keys-raw-write-refusal.md) | 05 |

## Suggested order

Start with **01**. It is the only ticket that unblocks two separate branches, and the spec
asks that it be landed and lived with for a few days before 09 and the rest — if the
workspace is still slow after it, there is a second cause not yet identified, and stacking
more work on top makes that harder to isolate.

**05** has no blockers but heads the largest and least certain branch. The spec's risk
section explains what to check before committing to it.
