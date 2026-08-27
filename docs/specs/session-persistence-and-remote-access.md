# Session Persistence and Remote Access

**Status**: Approved, not started
**Date**: 2026-08-27

Four related changes: fix the terminal performance and rendering defects, make managed
sessions survive their own exit, add on-demand session summaries, and reach the workspace
from a phone over Tailscale.

## Problem

Four observed problems, in the order they were reported:

1. The workspace gets slow.
2. Switching between sessions makes the terminal render incorrectly ("skews off").
3. A chat session's content is lost when the session ends or when `npm run dev` stops.
4. There is no way to talk to an agent from a phone while away from the machine.

## Root causes

Each was verified in the code before this spec was written.

### Slowness

`SessionManager.handleData` (`src/sessions/manager.ts:155`) calls `persist()` on **every PTY
chunk**. `persist()` (`src/sessions/manager.ts:316`) performs a synchronous `better-sqlite3`
upsert and emits `session_update`, which `src/server/ws.ts:59` broadcasts to every socket and
then rebuilds the entire companion snapshot once per socket.

A Claude Code TUI emits roughly 10–30 chunks/second while a spinner is animating. Four live
sessions is on the order of 100 synchronous database writes per second and 100 full-fleet
broadcasts per second, on the same event loop that carries keystrokes. This single path
produces the keystroke latency, the session-switch lag, and the idle jank.

Contributing, but secondary:

- `SessionManager.write` (`src/sessions/manager.ts:196`) performs a synchronous database write
  on every keystroke.
- Each PTY chunk becomes its own `JSON.stringify` frame per socket (`src/server/ws.ts:52`); no
  coalescing.
- `GridView` polls `/terminal-tail` per tile every 1.5s (`src/ui/workspace/GridView.tsx:24`).
- `App` re-renders the whole tree every second from a `setNow` clock
  (`src/ui/App.tsx:105`) and polls six REST endpoints every 5s.

### Terminal skew on switch

`TerminalWorkspace` keys `<Terminal>` on session id (`src/ui/workspace/TerminalWorkspace.tsx:60`),
so switching destroys and rebuilds the xterm instance. On attach, the server replays the ring
buffer (`src/server/ws.ts:97`) and the client does `term.reset(); term.write(...)`
(`src/ui/components/Terminal.tsx:100`).

The replayed bytes were line-wrapped at whatever `cols` the PTY had when they were written.
The rebuilt pane fits to a possibly different width and then sends a resize, which SIGWINCHes
the CLI mid-redraw. Width-N output is being rendered into a width-M grid. This is not a CSS
defect and cannot be fixed in CSS.

### Lost sessions

`RingBuffer` (`src/sessions/ringbuffer.ts`) is 64 KB, in memory, and never persisted.

More significantly, `handleExit` (`src/sessions/manager.ts:181`) calls
`store.deleteSession(sessionId)`. The comment states the intent: *"An exited session has
nothing left to show or act on — drop the row entirely."* History is therefore lost the moment
the agent exits, not when `npm run dev` stops. This spec reverses that decision.

### No remote access

The server binds `127.0.0.1` (`src/server/index.ts:64`), checks request origin
(`src/server/app.ts:95`), and has **no authentication** — loopback was the authentication.
A managed session is a shell running with the user's credentials, so any remote exposure is a
remote-code-execution surface and must be designed as one.

## Decisions

| Decision | Choice |
|---|---|
| Saved-session record | Raw PTY bytes, compacted to clean scrollback on exit |
| Coverage | Managed sessions only; external sessions get no history |
| Terminal architecture | Patch, not rebuild. PTY pinned at 100×30, no viewer resize authority |
| Live headless rendering | Only for sessions a phone is viewing; desktop path untouched |
| Summary trigger | Manual button only |
| Summary model | Opus 5 default via `claude -p`; picker with runtime-fetched list |
| Remote transport | Tailscale interface + loopback, token as second factor |
| Mobile capability | Reflowed text view, free-text composer, fixed control-key buttons |
| Ended sessions | Stay in the session rail ~1h, then move to History |

### Rationale for the non-obvious ones

**Pinned 100×30 with no viewer resize authority.** One PTY has one size. Any design where a
viewer's pane dictates that size reproduces the skew defect, and two simultaneous viewers
(desktop plus phone) turn it into a resize war. Pinning the size means one wrapping, forever,
across live view, saved replay, and mobile. The cost is accepted: a wide desktop pane will have
empty margin, and the terminal can no longer be made larger to show more. `src/sessions/pty.ts:32`
already defaults to 100×30, so existing sessions are unaffected.

**Manual summary trigger only.** Automatic summarization on exit would fire N summaries
simultaneously when `npm run dev` stops — precisely the case where the sessions were killed
deliberately and a summary is least wanted.

**Compaction is free; summarization is not.** Replaying saved bytes through a headless terminal
costs no tokens and about 200ms of CPU, so it runs on every exit. Only the model call is gated
behind the button.

**Raw keystrokes from mobile are restricted to a fixed control-key set.** Free-text conversation
with an agent already works through the existing composer
(`src/ui/workspace/TerminalWorkspace.tsx:110`, `POST /api/sessions/:id/send`). The remaining gap
is interrupting a stuck agent, which a fixed set of buttons (Ctrl-C, Esc, arrows, Enter) closes.
Arbitrary keystroke injection from a pocket device is not required by any stated need.

**A ChatGPT subscription does not provide an OpenAI API key.** They are separate products with
separate billing. GPT summaries cost real money per run; `claude -p` summaries ride the Claude
subscription and cost nothing in cash, consuming usage limits instead. The picker must label
which path each model uses.

## Module design

The existing patches, if applied at their call sites, would scatter one concern — what happens
to a session's output bytes — across `manager`, `ws`, and two UI files. `SessionManager` already
owns lifecycle, ring buffers, prompt injection, readiness detection, status inference,
persistence, and events; adding compaction and archival to it makes it wider still. Three
modules are extracted instead.

### SessionTranscript

Owns everything about the bytes a session produced.

```
append(data: string): void
snapshot(): string                     // replay on attach
subscribe(cb): Unsubscribe             // coalesced, ~16ms
close(): Promise<{ scrollbackPath }>   // headless replay, raw deleted
```

Hides: the ring buffer, the 5 MB tail cap, disk spill, the coalescing timer, compaction on
close, and the on-disk layout.

Deletion test: removing it puts ring-buffer logic back in `manager`, coalescing back in `ws`,
and file layout in two more places. It earns its keep.

After extraction, `handleData` is status inference plus `transcript.append(data)`. The
per-chunk `persist()` is deleted rather than patched.

### ScrollbackRenderer

```
render(bytes: string, opts: { cols: number, mode: 'grid' | 'reflow' }): string
```

Bytes in, text out. Hides the `@xterm/headless` lifecycle, buffer serialization, and ANSI
handling. Two callers: compaction on exit, and the live mobile reflow view. Pure-function
shape; tested with fixture bytes in and expected text out.

### ConnectionTrust

```
classify(req): { kind: 'local' | 'remote' | 'denied', capabilities: Set<Capability> }
```

`isLoopbackHostHeader` (`src/server/app.ts:42`) is currently consulted from three independent
places: the origin check (`src/server/app.ts:95`), the WebSocket `verifyClient`
(`src/server/ws.ts:29`), and the CSP `connect-src` header (`src/server/app.ts:81`). Adding the
tailnet host means changing a policy in three places; missing the CSP one lets the phone load
the page but silently blocks its WebSocket.

One `classify` decides once and is asked four times. The mobile raw-write restriction becomes a
capability in the returned set rather than a separate check that can be forgotten. This module
is prioritized because its failure mode is a security failure, not a rendering bug.

### Summarizer and ModelCatalog

`Summarizer.summarize(scrollback, { model }): Promise<string>` is a real seam: `claude -p` as a
subprocess and OpenAI over HTTP are two genuinely different adapters. It hides provider
selection, key resolution, the prompt, and input truncation.

`ModelCatalog.list(): Model[]` is kept separate — the picker needs the list without summarizing
anything, and folding it in would grow `Summarizer` to four methods. It hides the runtime fetch,
cache, allowlist filter, and per-provider auth detection.

Model IDs are **fetched at runtime** from each provider's models endpoint and filtered through
an allowlist. No model ID is hardcoded from memory; identifiers drift, and an unverifiable
string in source is worse than a fetch.

### Considered and rejected: SessionArchive

A module owning ended sessions, scrollback, and summaries. Deletion test: removing it gives the
store two extra columns and leaves `SessionTranscript.close()` returning a path. Complexity does
not reappear across callers, it moves back one level. That makes it a pass-through, so it is not
built. Summaries live on the existing store.

### Seam not to build

The remote transport. Tailscale is one adapter; a pluggable transport abstraction for a single
implementation is a hypothetical seam. Bind to the interface directly.

## Build stages

### Stage 1 — Performance

1. Extract `SessionTranscript`; test through its own interface.
2. `handleData` becomes status inference plus `append`. Remove the per-chunk `persist()`.
   Status changes still persist immediately; `lastActivityAt` gets a 4 Hz throttled flush.
3. Remove the synchronous write from `SessionManager.write` (`src/sessions/manager.ts:196`).
4. `ws.ts` subscribes to the transcript instead of listening to `manager`; coalescing logic
   leaves `ws` entirely.
5. `session_update` builds the companion snapshot once, not once per socket
   (`src/server/ws.ts:59`).
6. Remove the 1 Hz global `setNow` re-render (`src/ui/App.tsx:105`); move elapsed-time ticking
   into the leaf components that display it.
7. Replace `GridView`'s per-tile HTTP polling (`src/ui/workspace/GridView.tsx:24`) with pushed
   previews over the existing WebSocket.

**Acceptance**: with four live sessions running active agents, keystroke echo is not perceptibly
delayed, switching sessions is immediate, and the UI does not jank while idle.

**Land this and use it for several days before starting Stage 3.** If slowness persists, there
is a second cause that this spec has not identified, and that must be found before more is built
on top.

### Stage 2 — Terminal rendering

1. Make 100×30 authoritative in `PtyBackend` (`src/sessions/pty.ts:32`).
2. `ws.ts` stops honoring client `resize` frames (`src/server/ws.ts:117`).
3. `Terminal.tsx` drops the `ResizeObserver` resize path and letterboxes the fixed grid instead.
4. `TerminalWorkspace.tsx:60` stops keying on session id. Xterm instances stay alive per session,
   hidden; switching becomes a CSS toggle with no reset and no replay.

**Acceptance**: switching between sessions repeatedly, in panes of different sizes, never
produces misaligned output. A `resize` frame from a client causes no `backend.resize` call.

### Stage 3 — Persistence and summaries

1. Reverse `deleteSession` in `handleExit` (`src/sessions/manager.ts:181`); ended sessions get an
   `ended` status and an `endedAt`.
2. Raw stream spills to disk during the session, 5 MB tail cap (the tail is kept, so the end of a
   session — the part worth reopening — always survives).
3. On exit: `ScrollbackRenderer` compacts, scrollback is stored permanently, raw stream deleted.
4. History view; ended sessions age out of the rail after one hour or on restart.
5. Wrap-up button, `Summarizer`, `ModelCatalog`, settings for the model default and API key.

**Acceptance**: a session that has exited can be reopened and read. Pressing wrap-up produces a
summary. Restarting `npm run dev` does not lose either.

### Stage 4 — Mobile

1. `ConnectionTrust`; bind explicitly to the Tailscale interface address plus loopback (never
   `0.0.0.0`). Add the tailnet hostname to allowed origins **and** to the CSP `connect-src`.
2. Token generated on first run, stored in `~/.agentdeck/config.json` at 0600, entered once on
   the phone and held in localStorage. The token also marks a connection remote.
3. Reflow view: one `@xterm/headless` instance per phone-viewed session, serialized periodically
   as reflowed text. Off entirely when no phone is connected. Desktop path unchanged.
4. Composer, approval buttons, and the fixed control-key set. Raw write refused server-side for
   remote connections regardless of what the client sends.
5. Hold a `caffeinate` assertion while any managed session is live; release when the last ends.

**Acceptance**: from a phone on the tailnet, an agent's output is readable, a free-text message
reaches the agent, Ctrl-C interrupts it, and an attempt to send arbitrary raw input is refused
by the server.

## Storage

```
~/.agentdeck/
  agentdeck.db          sessions (including ended), summaries
  config.json           0600 — tailnet token, OpenAI API key
  sessions/<id>/
    raw.log             live only, 5 MB tail cap, deleted on compaction
    scrollback.txt      permanent
    summary.md          when generated
```

Secrets are never written to SQLite and never appear in REST responses or WebSocket broadcasts,
consistent with the existing treatment of launch specs (`src/server/security.ts`).

## Non-goals

- History for external (discovered) sessions. They have no PTY, so under a raw-bytes record they
  cannot have one. Revisiting this means revisiting the record format — see Risks.
- Automatic summarization on session exit.
- Idle-based session-end detection. It would misfire on long agent runs.
- Resizable desktop terminal panes.
- Server-side headless rendering for the desktop path.

## Risks

**The mobile feature only covers sessions launched from AgentDeck.** Agents started in iTerm or
another terminal are discovered but have no PTY, no stored bytes, and no history. If most real
work happens outside AgentDeck's launcher, Stage 4 ships and goes unused. Stage 4 is also the
largest stage. Check this honestly before starting it; if it holds, the record-format decision
must be reopened first, because the agents' own JSONL transcripts
(`~/.claude/projects/<slug>/*.jsonl`, `~/.codex/sessions/`) are the only possible record for an
external session.

**Live headless rendering narrows the gap to an architecture that was declined.** Stage 4 puts a
server-side headless terminal in the codebase for phone-viewed sessions only. Once it exists,
making it authoritative for all sessions — which would allow arbitrary desktop pane widths again
— is a small step. That is a future option, not part of this spec.

**Transcript format drift.** Not a risk under the chosen raw-bytes record, but it becomes one
immediately if external-session support is pulled forward. Any JSONL parser must be a pinned
adapter with a schema check that degrades rather than breaks.
