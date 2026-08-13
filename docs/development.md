# Development Guide

This guide covers local development, validation, troubleshooting, and contribution expectations for AgentDeck.

## Prerequisites

- macOS 13 or newer
- Node.js 20 or newer
- Git
- Xcode command-line tooling for the Swift companion and native tests
- Claude Code and/or Codex CLI for end-to-end session testing

Use the Node version declared in `.nvmrc` before installing dependencies:

```bash
nvm use
npm install
```

If Xcode command-line tooling is not installed:

```bash
xcode-select --install
```

## Development server

Run the UI and API together:

```bash
npm run dev
```

- Vite UI: [http://127.0.0.1:4040](http://127.0.0.1:4040)
- Fastify API and WebSocket server: `127.0.0.1:4041`

Vite proxies `/api` and `/ws` to Fastify. One `Ctrl+C` stops both processes.

The development server can run without a built native companion. Use the production build when validating the complete browser and native-companion package.

## Build and run

```bash
npm run build
npm start
```

The build performs TypeScript checking, builds the Vite UI and Node output, packages the VS Code helper, and builds the native Swift companion.

Set `AGENTDECK_NOTCH=0` to disable the companion while running the production server:

```bash
AGENTDECK_NOTCH=0 npm start
```

To use the local `agentdeck` command from other repositories while developing from source:

```bash
npm link
agentdeck --help
```

## Validation

Run the JavaScript and TypeScript test suite:

```bash
npm test
```

Run the Swift tests:

```bash
npm run test:notch
```

Run static checking and a full build:

```bash
npm run typecheck
npm run build
```

Validate the package contents:

```bash
npm pack
```

`npm pack` invokes the full build through the package's `prepack` script.

## Project layout

```text
bin/                     CLI entry points
docs/                    User and technical documentation
extensions/vscode/       Bundled VS Code terminal helper
migrations/              Numbered SQLite migrations
native/AgentDeckNotch/   Swift native companion
scripts/                 Development and packaging scripts
src/                     Server, UI, discovery, Git, hooks, and persistence
```

The interactive Git publishing prototype remains under `docs/prototypes/` as a design artifact; it is not the production interface.

## Troubleshooting

### `Node.js 20 or newer is required`

```bash
cd agentdeck
nvm use
npm install
```

Confirm that `node --version` reports version 20 or newer.

### SQLite reports a `NODE_MODULE_VERSION` mismatch

The native dependency was installed under a different Node major version:

```bash
nvm use
npm rebuild better-sqlite3
```

### A PTY fails to start after dependency installation

The post-install script restores the executable bit on the prebuilt `node-pty` spawn helper. Re-run installation under the selected Node version:

```bash
nvm use
npm install
```

### The native companion does not build

Confirm that an active Xcode toolchain is available:

```bash
xcode-select -p
xcrun swift --version
```

Install the command-line tools or select the appropriate Xcode installation before retrying `npm run build`.

### `Cannot check out a branch: the working tree is dirty`

AgentDeck refuses unsafe branch switches when Git reports modified, staged, or untracked files:

```bash
git status --short
```

Keep the branch field empty, commit the work, or stash it safely before requesting a checkout.

### An external session appears without a visible terminal

The CLI process may still be alive in a hidden or persistent Cursor or VS Code terminal. Inspect the process ID and TTY shown by AgentDeck:

```bash
ps -p <pid> -o pid,ppid,tty,lstart,command
```

### Terminal focus is unavailable

- Confirm macOS Automation permission.
- For Terminal.app or iTerm2, confirm the process belongs to the expected tab.
- For VS Code, install the helper and reload the editor window once.
- Cursor integrated terminals may remain unknown and cannot always be focused.

See [Integrations](integrations.md) for setup details.

### Repositories do not appear

- Confirm `projectsDir` in `~/.agentdeck/config.json`.
- Confirm repositories are direct children of that directory.
- Confirm each repository contains a `.git` directory or `.git` worktree file.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository.
2. Create a focused branch.
3. Add or update tests for behavioral changes.
4. Run the relevant validation commands.
5. Open a pull request describing the problem, approach, and manual testing performed.

Do not commit personal project names, absolute user paths, API keys, captured credentials, or real terminal and session payloads in tests, documentation, or screenshots.
