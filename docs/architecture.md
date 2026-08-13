# Architecture

AgentDeck is a local macOS application composed of a browser workspace, a Node.js control server, terminal and editor integrations, local persistence, and a native status companion. It does not require a hosted backend.

## Runtime overview

```text
React workspace
    │ REST + WebSocket on loopback
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

The production server serves the built browser application and API on `127.0.0.1:4040`. In development, Vite serves the UI on port `4040` and proxies API and WebSocket traffic to Fastify on port `4041`.

## Main components

### Browser workspace

The interface is implemented with React, TypeScript, and Vite under `src/ui/`. It includes the Operations, Terminal, Changes, and Grid workspaces, the launch manifest, command palette, session rail, and inspector.

The managed terminal uses xterm.js. REST requests handle application actions and queries, while a WebSocket connection carries terminal I/O and live session updates.

### Control server

The Fastify server under `src/server/` coordinates sessions, repositories, integrations, and persistence. Its REST and WebSocket routes are an internal interface for the local UI and companion rather than a versioned public API.

The server binds only to loopback. Production also serves the compiled single-page application from `dist/ui`.

### Managed terminals

Managed sessions use `node-pty` to launch Claude Code or Codex CLI. AgentDeck owns these child processes and can send input, resize the PTY, stop it, or restart it from an in-memory launch specification.

Initial prompts, arguments, and environment overrides can contain sensitive values. They are kept in memory for restart support and are removed from browser-visible session objects and SQLite persistence.

### External discovery

The discovery subsystem polls macOS processes for interactive Claude Code and Codex sessions. It filters desktop helpers, wrappers, sandboxes, and duplicate child processes, then correlates process IDs and TTYs with supported terminal applications.

Terminal.app and iTerm2 adapters use macOS scripting for focus and direct input. A separate VS Code bridge maps integrated terminal shell process IDs to the connected editor window.

### Repository and Git services

The repository scanner inspects direct children of the configured projects directory and recognizes normal repositories and linked worktrees. Git services provide working-tree summaries, branch comparisons, file diffs, staging actions, local commits, pushes, and pull-request publishing.

File and repository actions are limited to repositories already known to AgentDeck. Requested file paths are resolved and checked against their repository boundary.

### Coordination and hooks

Claude Code hooks and Codex notifications are normalized into shared session and coordination events. Repository-local JSONL files provide claims, progress, blockers, dependencies, and queued Claude messages. See [Coordination](coordination.md) for the event workflow.

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

## Local security boundaries

- HTTP and WebSocket listeners bind to `127.0.0.1` only.
- Requests must use an allowed loopback host and the exact origin serving AgentDeck.
- WebSocket upgrades are origin-checked separately.
- Content Security Policy and defensive browser headers restrict the local UI.
- Repository actions are limited to discovered repositories and constrained paths.
- Database files are restricted to the current operating-system user.
- Managed launch secrets are excluded from REST responses, WebSocket broadcasts, and persistence.
- The VS Code helper accepts only loopback `ws://` or `wss://` server URLs.

Claude Code and Codex continue to communicate with their respective providers according to their own configuration. Do not place AgentDeck behind a public proxy without adding authentication and accounting for the terminal access exposed by managed sessions.

## Primary technologies

- React 18, TypeScript, and Vite
- Node.js, Fastify, and WebSockets
- xterm.js and node-pty
- SQLite through better-sqlite3
- Swift and SwiftUI
- Vitest and Swift Package Manager tests
- macOS Automation and a bundled VS Code extension
