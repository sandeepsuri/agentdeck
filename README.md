# AgentDeck

**A local-first macOS control panel for Claude Code and Codex CLI sessions.**

AgentDeck brings parallel coding agents into one workspace. Instead of tracking scattered terminal tabs, repositories, approval prompts, and working-tree changes by hand, you can launch or discover sessions, respond when an agent needs attention, review changes, and spot overlapping work from a single dashboard.

AgentDeck runs entirely on your Mac, binds only to `127.0.0.1`, and stores application state in a local SQLite database. It is currently an early MVP for macOS; Terminal.app support is verified, while iTerm2 support remains experimental.

## Preview

![AgentDeck Operations workspace showing fictional sessions, repositories, attention states, and working-tree activity](docs/screenshots/operations-dark.png)

_All screenshot data is fictional._

## Key Features

- Launch Claude Code and Codex sessions in managed browser terminals, or discover sessions already running in supported macOS terminals.
- Monitor agent activity, approval prompts, replies, repository state, and conflicts across multiple projects.
- Review uncommitted or branch changes with unified and split diffs, staging controls, and editor actions.
- Commit staged work and publish branches as draft or ready GitHub pull requests.
- Focus and message mapped Terminal.app, iTerm2, and VS Code integrated terminals.
- Coordinate parallel work through file claims, progress events, blockers, task dependencies, and conflict warnings.
- Keep active agents and attention prompts visible through the native MacBook notch or menu-bar companion.

## Getting Started

### Prerequisites

- macOS 13 or newer
- Node.js 20 or newer
- Git
- Claude Code and/or Codex CLI installed and authenticated
- Xcode command-line tooling when building the native companion

AgentDeck includes an `.nvmrc` for the supported Node version.

### Install and run in development

```bash
git clone https://github.com/sandeepsuri/agentdeck.git
cd agentdeck
nvm use
npm install
npm run dev
```

Open [http://127.0.0.1:4040](http://127.0.0.1:4040).

No project `.env` file, external database, or backend service is required. AgentDeck creates and migrates its local SQLite database automatically under `~/.agentdeck/`.

### Build and run locally

Install the Xcode command-line tools if they are not already available:

```bash
xcode-select --install
```

Then build and start the application:

```bash
npm run build
npm start
```

To run only the browser application without the native companion:

```bash
AGENTDECK_NOTCH=0 npm start
```

Repository discovery works without configuration and scans one directory level from the inferred projects directory. See the [user guide](docs/user-guide.md#repository-discovery) to configure a fixed location.

## Documentation

- [User guide](docs/user-guide.md) — workspace navigation, session management, code review, publishing, and configuration
- [Integrations](docs/integrations.md) — terminal focus, VS Code, Claude and Codex hooks, and GitHub CLI
- [Coordination](docs/coordination.md) — claims, progress, blockers, dependencies, statuses, and conflict warnings
- [Architecture](docs/architecture.md) — system components, local persistence, communication, and security boundaries
- [Development](docs/development.md) — development workflow, validation, troubleshooting, and contributions

## Contributing

Issues and pull requests are welcome. See the [development guide](docs/development.md) before submitting a change.

## License

AgentDeck is available under the [MIT License](LICENSE).
