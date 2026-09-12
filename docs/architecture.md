# Architecture

AgentDeck is a local macOS application composed of a browser workspace, a Node.js control server, terminal and editor integrations, local persistence, and a native status companion. It does not require a hosted backend.

## Runtime overview

```text
React workspace
    │ REST + WebSocket on loopback or authenticated tailnet listener
    ▼
Fastify control server
    ├── managed PTYs
    ├── macOS process and terminal discovery
    ├── Git inspection and publishing
    ├── hook ingestion and coordination
    ├── SQLite persistence
    ├── VS Code terminal bridge
    └── native Swift companion
```

The production server serves the built browser application and API on `127.0.0.1:4040`. When Tailscale is detected, it adds a second listener on that interface's concrete IPv4 address—never a wildcard address. In development, Vite serves the UI on port `4040` on loopback and, when available, the concrete Tailscale IP; both proxy API and WebSocket traffic to Fastify on port `4041`.

## Main components

### Browser workspace

The interface is implemented with React, TypeScript, and Vite under `src/ui/`. A local, loopback connection renders the Admin shell: the Overview, Tasks, Operations, Sessions, Changes, Grid, Signals, and History workspaces, plus the launch manifest, command palette, session rail, and inspector. Settings (General, Profiles, and Collaborators tabs) renders as an additional page in the same workspace stage rather than a modal. A remote connection instead renders a repository-first Collaborator workspace scoped to that device's grants; see [Runs and the Work Engine](#runs-and-the-work-engine) and the [user guide](user-guide.md#admin-and-collaborator-workspaces).

The managed terminal uses xterm.js. REST requests handle application actions and queries, while a WebSocket connection carries terminal I/O and live session updates.

### Control server

The Fastify server under `src/server/` coordinates sessions, repositories, integrations, and persistence. Its REST and WebSocket routes are an internal interface for the local UI and companion rather than a versioned public API.

The server always binds loopback. It may also bind the detected concrete Tailscale IPv4 interface. Production serves the compiled single-page application from `dist/ui`; development runs matching loopback and tailnet Vite listeners so a phone reaches the UI on the public port rather than the API-only port.

### Managed terminals

Managed sessions use `node-pty` to launch Claude Code or Codex CLI. AgentDeck owns these child processes and can send input, resize the PTY, stop it, or restart it from an in-memory launch specification.

Initial prompts, arguments, and environment overrides can contain sensitive values. They are kept in memory for restart support and are removed from browser-visible session objects and SQLite persistence.

### External discovery

The discovery subsystem polls macOS processes for interactive Claude Code and Codex sessions. It filters desktop helpers, wrappers, sandboxes, and duplicate child processes, then correlates process IDs and TTYs with supported terminal applications.

Terminal.app and iTerm2 adapters use macOS scripting for focus and direct input. A separate VS Code bridge maps integrated terminal shell process IDs to the connected editor window.

### Repository and Git services

The repository scanner inspects direct children of the configured projects directory and recognizes normal repositories and linked worktrees. Git services provide working-tree summaries, branch comparisons, file diffs, staging actions, local commits, pushes, and pull-request publishing.

File and repository actions are limited to repositories already known to AgentDeck. Requested file paths are resolved and checked against their repository boundary.

### Runs and the Work Engine

The Work Engine under `src/work-engine/` executes Runs: durable objectives with their own identity and lifecycle, tracked independently of any Session or terminal process. A Run's immutable Work specification — objective, acceptance criteria, Repository, requested base reference, runtime preference, budget, verification intent, and requested delivery result — is either authored directly by an admin through the Run submission flow, or, for a collaborator, derived entirely from an admin-granted Profile rather than anything the collaborator submits.

A Run advances through one or more Attempts, each a distinct runtime execution; retrying creates a new Attempt rather than reusing the previous one, and pause/resume act only at engine-controlled safe boundaries. A completed Run's outcome is captured as a durable Run result (delivery artifacts, verification evidence, approvals, usage, and recovery notes). Run feedback and review decisions (`reviewed` / `changes_requested`) are stored as plain, append-only entries rather than a mutable Run status, and the review UI derives its badge text from the latest entries.

Companion Sessions are a read-only, admin-only correlation between a Run's prepared worktree and any Session that happens to already exist for it — advisory only, never persisted, and never implying that starting an Attempt created or owns that Session.

Publication is a separate, explicit, admin-only action taken after a Run produces a delivery commit: it is never triggered automatically by Run completion. It pushes the branch and, optionally, opens a draft pull request, and it is persisted before execution so it settles as succeeded, failed, or ambiguous rather than being inferred after the fact. Publication is never available to a collaborator.

A Run's static-HTML preview is served through a separate, ephemeral, loopback-only preview listener minted per request; it is never exposed to a remote or collaborator connection.

### Coordination and hooks

Claude Code hooks and Codex notifications are normalized into shared session and coordination events. Repository-local JSONL files provide claims, progress, blockers, dependencies, and queued Claude messages. See [Coordination](coordination.md) for the event workflow.

### Shared Session interactions

Shared Session chat keeps provider questions and approvals in the existing Session; it never creates a Run or replacement Session. Claude repository hooks bridge structured `AskUserQuestion` (`PreToolUse`) and `PermissionRequest` events to durable `session_interactions` rows. Provider Session and request identities remain server-side. The waiting hook polls its exact request and separately acknowledges collection of the response, so resolving a row does not falsely imply provider delivery. Conditional resolution accepts only the first participant response, while refresh and reconnect recover the durable request, attribution, and delivery state.

The loopback-only provider interface ingests, polls, acknowledges, and expires Claude requests under `/api/provider/claude/interactions`. Granted Admin and Collaborator views read safe projections from `GET /api/sessions/:id/interactions`; `POST /api/sessions/:id/interactions/:requestId/respond` validates an answer or decision against the exact pending request. Repository grants allow ordinary question answers, but do not confer approval authority: approvals remain restricted to an authorized local admin. Browser projections exclude provider identifiers, absolute paths, credentials, and raw hook payloads.

Codex `notify` reports completed interactive terminal turns but does not expose app-server approvals or `requestUserInput` for a Session. Managed and external Codex Sessions therefore report the interaction control as unavailable. The structured Codex bridge used by Runs is intentionally not reused because Runs and Sessions have separate identity and lifecycle.

Processing state is derived from persisted request/delivery acknowledgements plus structured provider and Session events. A chat POST records chat/terminal transport only: ordinary chat never starts a working indicator, and an agent-addressed message remains delivery-pending until later provider activity. Streaming silence is not completion.

### Native companion

The companion is a Swift/SwiftUI macOS executable under `native/AgentDeckNotch/`. It receives live state from the loopback server and presents active agents and attention prompts around a MacBook notch or in a menu-bar fallback.

The native companion is built as part of `npm run build`, copied into the distribution tree, and signed locally with an ad hoc signature.

### VS Code helper

The bundled extension under `extensions/vscode/` connects to AgentDeck over a loopback WebSocket. It reports integrated terminal process IDs so AgentDeck can target the correct split terminal for focus and messaging.

## Persistence

AgentDeck uses `better-sqlite3` and numbered migrations under `migrations/`. The default database is `~/.agentdeck/agentdeck.db`.

The current schema stores:

- Session identity, process metadata, repository association, and status
- Tasks and dependencies
- Runs, Attempts, Work specifications, Run results, feedback, and review decisions
- Profiles, Collaborators, Device credentials (hashed), and Publications
- Discovered repositories and worktrees
- Application settings
- An archive of ingested coordination events
- Applied database migrations

Managed-session launch prompts, command arguments, and environment overrides are intentionally not written to the database.

Repository coordination data remains inside each repository under `.agents/`. Hook installation can update `.claude/settings.json` and, when requested, `~/.codex/config.toml`; backups are created before modifying existing configuration.

## Status derivation

Session state combines several signals:

1. Hook events
2. Managed terminal output
3. Sustained CPU activity
4. Process liveness

Higher-confidence hook and output signals take precedence over CPU inference. Conflict state is derived from current sessions, repositories, claims, and dependencies rather than stored as a permanent record.

## Connection security boundaries

- HTTP and WebSocket listeners always bind `127.0.0.1`; optional remote listeners bind only the detected concrete Tailscale IPv4 address, never `0.0.0.0`.
- Requests must use an allowed loopback host or either detected tailnet identity (MagicDNS hostname or raw IP), with the exact origin serving AgentDeck.
- Remote REST and WebSocket requests require either the owner-only token stored in `~/.agentdeck/config.json` or an individually revocable, per-device Device credential minted by exchanging a one-time Invitation; WebSocket upgrades are origin-checked separately.
- Local connections retain all capabilities. An authenticated collaborator device sees only the Repositories and Profiles an admin explicitly granted it: a scoped feed of Runs and Sessions, the ability to submit Runs derived from a granted Profile, chat participation, and answers to ordinary agent questions. It cannot enumerate or attach to external sessions, use arbitrary raw writes, view or change Settings, manage Collaborators or Profiles, approve or deny a permission request, or publish a Run's result — those remain admin-only regardless of grants.
- Content Security Policy and defensive browser headers restrict the local UI.
- Repository actions are limited to discovered repositories and constrained paths.
- Database files are restricted to the current operating-system user.
- Managed launch secrets are excluded from REST responses, WebSocket broadcasts, and persistence.
- The VS Code helper accepts only loopback `ws://` or `wss://` server URLs.

Claude Code and Codex continue to communicate with their respective providers according to their own configuration. Tailscale plus an owner token or collaborator Device credential is the only supported remote boundary; do not place AgentDeck behind a public proxy.

## Primary technologies

- React 18, TypeScript, and Vite
- Node.js, Fastify, and WebSockets
- xterm.js and node-pty
- SQLite through better-sqlite3
- Swift and SwiftUI
- Vitest and Swift Package Manager tests
- macOS Automation and a bundled VS Code extension
