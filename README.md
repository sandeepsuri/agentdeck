# AgentDeck

**A local-first macOS control panel for Claude Code and Codex CLI sessions.**

AgentDeck gives you one high-density workspace for starting agents, discovering agents that are already running, operating managed terminals, reviewing code changes as they land, focusing external terminal tabs, sending follow-up messages, and spotting risky concurrent work across repositories.

- Runs locally and binds only to `127.0.0.1`
- Supports Claude Code and Codex CLI
- Stores application state in a local SQLite database
- Licensed under the [MIT License](LICENSE)

> AgentDeck is an early MVP for macOS. Terminal.app support is verified; iTerm2 support is included but still considered experimental.

## Screenshots

### Operations workspace

The Operations view turns every active repository into a compact process surface. Managed and discovered sessions stay visible in the persistent rail, while attention prompts, activity, working-tree health, conflicts, and session controls share one workspace.

![AgentDeck Operations workspace in the Obsidian theme with fictional sessions](docs/screenshots/operations-dark.png)

### Integrated terminal and attention queue

Use a managed PTY directly in AgentDeck, respond to approval prompts, or queue the next instruction without losing terminal history when switching views. External sessions expose their owning terminal and focus action in the same workspace.

![AgentDeck terminal workspace in the Obsidian theme with fictional terminal output](docs/screenshots/terminal-dark.png)

### Review code changes

The dedicated Changes workspace combines a file rail, agent claims, unified or split diffs, whitespace controls, and file actions. The Porcelain appearance shown here follows a light operating-system theme.

![AgentDeck Changes workspace in the Porcelain theme with a fictional repository diff](docs/screenshots/changes-light.png)

### Mission control grid

Open the Grid view for an at-a-glance terminal wall across all managed and discovered sessions. Status lamps, identity, repository, branch, runtime, and recent output make parallel work easy to scan.

![AgentDeck mission control grid in the Obsidian theme with fictional sessions](docs/screenshots/mission-control-dark.png)

### Launch manifest and preflight

Configure the agent, workspace, branch, objective, permission mode, and environment in a structured launch manifest. AgentDeck checks the directory, Git state, CLI, and PTY readiness before initialization and previews the resulting command.

![AgentDeck launch manifest in the Obsidian theme with fictional example data](docs/screenshots/launcher-dark.png)

All screenshot data is fictional.

## What You Can Do

- See Claude Code and Codex sessions across multiple repositories in one place.
- Keep managed and discovered sessions visible in a persistent, status-aware session rail.
- Launch managed agents and interact with their terminal directly in the browser.
- Discover agents already running in Terminal.app, iTerm2, Cursor, or VS Code terminals.
- Focus a mapped Terminal.app, iTerm2, or VS Code integrated terminal from the workspace.
- Send prompts or follow-up messages to supported managed and external sessions.
- Track whether an agent is starting, working, waiting for input, idle, completed, or gone.
- Keep active agents, repositories, replies, and approval prompts visible around the MacBook notch when the browser is hidden.
- Watch staged, unstaged, and untracked changes land live, or compare the current branch with its base branch.
- Review unified or split diffs, stage or unstage files, discard changes, and open files in your editor.
- Commit staged changes locally or publish the current branch as a draft or ready GitHub pull request.
- Scan every session at once in the terminal-style mission control grid.
- Jump between views, sessions, and actions with the command palette.
- Label sessions so long-running work is easier to identify.
- Track tasks, file claims, blockers, progress, and completion through a repository-local coordination bus.
- Detect same-repository work, overlapping file claims, dirty working trees, and unmet task dependencies.
- Install and remove Claude Code hooks and Codex notifications without replacing existing hook commands.

## Features

| Area | Capability |
| --- | --- |
| Managed sessions | Launch Claude Code or Codex in a PTY, view output, type commands, resize the terminal, stop, and restart. |
| External discovery | Polls macOS processes for interactive Claude/Codex sessions and excludes desktop helpers, launch wrappers, sandboxes, and duplicate child processes. |
| Repository scanner | Scans one directory level for Git repositories and linked worktrees, including branch and dirty-tree information. |
| Safe launch manifest | Preflights the directory, repository, branch, agent CLI, and PTY; can check out or create a branch but refuses unsafe switches on a dirty tree. |
| Unified workspace | Persistent managed/discovered rail with Operations, Terminal, Changes, Grid, command palette, inspector controls, and live WebSocket updates. |
| Adaptive appearance | Follows the operating system by default with warm Porcelain light and Obsidian dark themes, plus persistent System, Light, and Dark overrides. |
| Code review | Shows uncommitted or branch changes with a file rail, agent claims, unified/split layouts, whitespace control, staging, discard, review, and editor actions. |
| Git publishing | Commits only staged changes, pushes the current branch to `origin`, and creates draft or ready GitHub pull requests through the authenticated GitHub CLI. |
| Terminal focus | Maps TTYs to Terminal.app, iTerm2, and connected VS Code terminals and can bring the exact terminal to the foreground. |
| Agent status | Combines hook events, managed terminal output, process liveness, and sustained CPU activity using `hook > output > CPU` precedence. |
| Notch companion | Morphs from a quiet top-edge status surface into a repo-grouped agent dashboard, sends macOS notifications while the browser is hidden, and falls back to a menu-bar panel on displays without a notch. |
| Hooks | Claude Code hooks report prompts, tool usage, edits, notifications, starts, and stops. Codex notify reports completed turns. |
| Messaging | Sends directly to managed PTYs and scriptable terminal tabs; queued Claude messages can be delivered through hooks on the next turn. |
| Coordination | Uses `.agents/bus.jsonl` for claims, progress, blockers, messages, task dependencies, and completion events. |
| Generated status | Creates `.agents/STATUS.md` as a human-readable summary of active agents, claims, blockers, and recent messages. |
| Conflict awareness | Warns about multiple sessions in one repository, overlapping file claims, dirty shared trees, and unmet dependencies. |
| Persistence | Stores sessions, tasks, repositories, events, labels, and settings in SQLite under `~/.agentdeck/`. |
| Local security | Serves only on `127.0.0.1`; it is not exposed to the local network by default. |

## Requirements

- macOS 13 or newer
- Node.js 20 or newer
- Git
- Claude Code and/or Codex CLI installed and authenticated
- Terminal.app or iTerm2 for focus support

AgentDeck includes an `.nvmrc`. If your default shell uses an older Node version, always run `nvm use` before installing dependencies or starting the app.

## Step-by-Step Setup

### 1. Clone the repository

```bash
git clone https://github.com/sandeepsuri/agentdeck.git
cd agentdeck
```

### 2. Select the required Node version

With [nvm](https://github.com/nvm-sh/nvm-sh):

```bash
nvm use
node --version
```

The reported version must be Node 20 or newer.

### 3. Install dependencies

```bash
npm install
```

If native SQLite dependencies were previously installed under another Node major version, rebuild them after `nvm use`:

```bash
npm rebuild better-sqlite3
```

### 4. Build AgentDeck

```bash
npm run build
```

### 5. Start AgentDeck

```bash
npm start
```

You can also run the local package binary:

```bash
npx agentdeck
```

To use the `agentdeck` command from other repositories while developing from source, link the local package once:

```bash
npm link
agentdeck --help
```

### 6. Open the workspace

Open [http://127.0.0.1:4040](http://127.0.0.1:4040).

The header should show `● live`. AgentDeck immediately scans for repositories and already-running agents, then refreshes external discovery every five seconds by default. The interface follows the current macOS appearance; use the appearance control in the top bar to choose **System**, **Light**, or **Dark**.

The native AgentDeck companion launches with the server. On a notched MacBook display it is flush with the top screen edge around the camera housing; otherwise it uses a menu-bar pill and detached panel. Hover to inspect active agents, click the compact face to pin it open, or use **Open Session** to jump to the exact terminal. The first reply or approval prompt may trigger a macOS notification-permission request.

To run only the browser UI, set `AGENTDECK_NOTCH=0` before starting AgentDeck.

### 7. Allow terminal focus when requested

macOS may ask whether your terminal or Node process can control Terminal.app or iTerm2. This permission is required only for listing, focusing, or typing into external terminal tabs.

If permission was denied, open:

**System Settings → Privacy & Security → Automation**

AgentDeck continues running when Automation permission is unavailable.

### 8. Connect VS Code integrated terminals

Install the bundled local extension, then reload each open VS Code window once. The extension reports terminal shell process IDs to AgentDeck so prompts and focus actions reach the exact split terminal, and it connects only to AgentDeck on loopback. The installer is available through AgentDeck's local integration endpoint:

```bash
curl -X POST http://127.0.0.1:4040/api/integrations/vscode/install
```

This command requires the VS Code `code` shell command. In VS Code, open the Command Palette and run **Shell Command: Install 'code' command in PATH** if AgentDeck reports that the CLI is unavailable.

### 9. Install hooks for richer status and messaging

From the workspace:

1. Select a session in the target repository.
2. Click **Install hooks**.
3. Restart any Claude Code or Codex sessions that were already running when the hooks were installed.
4. Run a turn in the agent so AgentDeck can associate the hook identity with the discovered session.

The workspace installer adds repository-level Claude hooks and a user-level Codex notify command. Existing hook commands are retained, timestamped backups are created, and an existing Codex notify command is chained.

You can install hooks from the CLI instead:

```bash
# Claude hooks for one repository
agentdeck install-hooks /Users/you/Projects/example-app

# Codex user-level notify hook
agentdeck install-hooks --user

# Install both in one command
agentdeck install-hooks /Users/you/Projects/example-app --user
```

Remove them symmetrically:

```bash
agentdeck uninstall-hooks /Users/you/Projects/example-app
agentdeck uninstall-hooks --user
```

## Configure Repository Discovery

Without a config file, AgentDeck derives `projectsDir` from where it was started:

- Started inside a Git repository: scans the repository's parent directory.
- Started elsewhere: scans the current directory.

AgentDeck scans exactly one directory level. To configure a fixed projects directory, create `~/.agentdeck/config.json`:

```json
{
  "port": 4040,
  "projectsDir": "/Users/you/Projects",
  "pollIntervalMs": 5000,
  "dataDir": "/Users/you/.agentdeck"
}
```

Restart AgentDeck after changing the config file.

## Navigate the Workspace

AgentDeck keeps two kinds of sessions in the left rail:

### Managed sessions

Managed sessions were launched from AgentDeck. Select one to inspect its current process, then open **Terminal** to use its browser PTY. Stop, restart, and rename controls remain available in the inspector.

### External sessions

External sessions were started elsewhere and discovered from the macOS process table. Select one to inspect:

- Process ID
- TTY
- Repository and branch
- Status and status source
- Owning terminal application, when known
- **Focus terminal** and message controls, when supported

Terminal.app and iTerm2 sessions use macOS Automation. VS Code integrated terminals become focusable and scriptable after the bundled helper connects. Cursor terminals may still appear as `unknown`.

### Views and keyboard shortcuts

- **Operations** organizes active work by repository and surfaces agents requiring attention, live process cards, worktree health, and conflicts.
- **Terminal** hosts the managed xterm.js PTY or the focus controls for an external terminal. The PTY stays mounted when you switch views, preserving its connection and history.
- **Changes** provides repository-wide code review and file actions.
- **Grid** is a mission-control wall for scanning all sessions and recent terminal output.
- Press `⌘K` to open the command palette and jump to a view, session, or action.
- Press `⌘L` to open the launch manifest.
- Press `1` through `9` to select the corresponding visible session.

## Review Code Changes

Select a session, then open **Changes**. The badge in the top navigation shows the current number of uncommitted files for the selected repository. The left file rail separates modified and untracked files, shows per-file line counts, and includes any active agent claims.

The viewer has two modes:

- **Uncommitted** combines staged, unstaged, and untracked working-tree changes.
- **vs base branch** shows committed changes on the current branch since it diverged from its base. AgentDeck resolves the base from `origin/HEAD`, then falls back to `main` or `master`.

Each file shows its Git status (`M`, `A`, `D`, `R`, or `?`) and added/deleted line counts. Select a file to review its colored diff in **Unified** or **Split** layout, optionally ignoring whitespace. You can move between files, stage or unstage the selection, discard it after confirmation, mark it reviewed, or open it through the VS Code CLI. Binary files are identified without rendering text, and very large file diffs are limited to the first 512 KB. The summary and open diff refresh every five seconds so you can follow an agent's edits as they land.

## Commit and Publish Changes

In **Changes**, use **Commit staged** to create a local commit or **Create PR** to publish the current branch. AgentDeck commits only Git's staged snapshot; partially staged and unstaged edits remain in the working tree.

Pull request publishing supports GitHub repositories with an `origin` remote and uses the authenticated [GitHub CLI](https://cli.github.com/) without storing access tokens. Install and authenticate it before creating a pull request:

```bash
brew install gh
gh auth login
```

The publish preflight checks the current branch, base branch, Git identity, remote, upstream, GitHub authentication, and existing pull requests. If a later step fails after a commit or push succeeds, retrying resumes at the failed step instead of repeating completed work.

## How to Start, Stop, and Restart Agents

### Start a managed agent

1. Click **Launch agent**.
2. Choose **Claude** or **Codex**.
3. Select a scanned repository or enter a free path.
4. Optionally provide a session name, branch, and initial objective. Enable **Create branch if missing** when needed.
5. Choose **Ask**, **Auto-edit**, or **Plan** permission mode.
6. Add environment variables individually or import a local `.env` file.
7. Review the launch manifest, command preview, and preflight checks.
8. Click **Initialize session** or press `⌘Enter`. AgentDeck opens the new managed terminal automatically.

AgentDeck checks the repository immediately before any checkout or branch creation. It refuses to switch branches when modified, staged, or untracked files are present. Leave the branch blank to keep the current branch.

### Stop a managed agent

1. Select the managed session.
2. Click **Stop** in the inspector.

AgentDeck sends `SIGTERM`, escalates to `SIGKILL` only if necessary, and removes the row after the process exits.

### Restart a managed agent

1. Select the managed session.
2. Click **Restart** in the inspector.

AgentDeck relaunches the stored launch specification with the same session label and working directory.

### Stop an external agent

AgentDeck does not own external processes, so it does not show a Stop button for them.

Preferred method:

1. Open the external session details.
2. Click **Focus terminal** when available.
3. Press `Ctrl+C` in the owning terminal.
4. Run `exit` if you also want to close the shell.

If the terminal cannot be focused, use the displayed process ID carefully:

```bash
ps -p <pid> -o pid,tty,command
kill <pid>
```

Avoid broad commands such as `pkill claude` or `pkill codex`; they can terminate unrelated sessions. The row disappears after the next discovery poll once the process is gone.

## Turn Monitoring On or Off

The **Install hooks** control enables enhanced monitoring and queued Claude messaging; it does not start or stop the agent process itself. Remove hooks with the `agentdeck uninstall-hooks` commands shown above.

- Hooks on: richer status changes, edit claims, completed-turn messages, and queued Claude delivery.
- Hooks off: process discovery and CPU status still work, but hook-driven details are unavailable.

Select a session before clicking the hook button so its repository is targeted. If no session is selected, AgentDeck uses the first discovered repository.

## Send Messages to Agents

Managed sessions expose their terminal directly in AgentDeck; type into that terminal as you would in the original CLI. The Terminal composer can send a response immediately or hold instructions in the local next-turn queue. For external sessions:

- Terminal.app/iTerm2 sessions: AgentDeck types into the mapped tab through Automation.
- VS Code sessions: the companion extension sends the prompt to the exact mapped integrated terminal.
- Claude in an unknown terminal: with hooks installed and associated, the message is queued and delivered as additional context on the next prompt or session start.
- Codex in an unknown terminal: queued inbound delivery is not currently available.

Messages sent from the workspace and supported agent replies appear in the session conversation history.

Direct prompt delivery can work before hooks are installed when AgentDeck can script the owning terminal. Capturing agent replies and richer status events requires hooks; restart any CLI sessions that were already open when the hooks were installed.

## Coordination Bus

Each observed repository can contain:

```text
.agents/
├── bus.jsonl       # append-only agent events
├── inbox.jsonl     # queued dashboard-to-Claude messages
└── STATUS.md       # generated human-readable status
```

Post coordination events from inside a Git repository:

```bash
# Claim files before editing
agentdeck post \
  --event claim \
  --task WEB-42 \
  --files src/components/Dashboard.tsx,src/styles/dashboard.css \
  -m "Starting dashboard work"

# Report progress (the percentage is optional and is never inferred)
agentdeck post --event progress --task WEB-42 --progress 65 -m "Table and filters complete"

# Report a blocker
agentdeck post --event blocked --task WEB-42 --blockers API-7 -m "Waiting for schema"

# Release files or finish the task
agentdeck post --event release --task WEB-42 --files src/components/Dashboard.tsx
agentdeck post --event done --task WEB-42 -m "Dashboard complete"
```

AgentDeck infers the repository root from the current working directory. Events are shown live in the workspace and regenerate `.agents/STATUS.md`.

## Understanding Status

| Status | Meaning |
| --- | --- |
| `starting` | A managed CLI process has launched but is not ready yet. |
| `working` | Recent hook, terminal output, or sustained CPU activity indicates active work. |
| `waiting_input` | The agent is waiting for approval, input, or another user action. |
| `idle` | The process is alive but is not currently doing meaningful work. |
| `completed` | The tracked task or turn has completed. |
| `unknown` | The process is alive but AgentDeck does not have a strong status signal. |

Hover over a status chip to see whether the winning signal came from a hook, output heuristic, CPU heuristic, or process exit.

The notch companion turns hook events into three user-facing attention reasons:

- **Agent replied** — a Claude or Codex turn completed.
- **Action required** — an approval or permission prompt is waiting.
- **Response required** — the agent explicitly requested user input.

A newer working signal clears the prior attention item. Only attention, working, and starting sessions appear in the expanded companion; inactive history remains available in the browser dashboard. When an agent does not report `--progress`, the companion uses an indeterminate activity bar instead of inventing a percentage.

## Conflict Warnings

AgentDeck derives conflicts instead of storing them permanently:

- **same repo** — multiple active sessions share a repository.
- **file overlap** — multiple agents claim the same file.
- **dirty tree** — concurrent sessions are operating in a dirty repository.
- **dependency wait** — a task depends on another task that is not complete.

For concurrent work, prefer separate branches or Git worktrees. Automatic worktree creation is planned but is not enabled in the current launch form.

## Data and Security

- The HTTP and WebSocket server binds to `127.0.0.1` only.
- Browser requests must come from the exact loopback origin serving AgentDeck; other localhost sites are rejected.
- Code-change requests are limited to repositories already known to AgentDeck, and file paths are constrained to their repository.
- The main database is stored at `~/.agentdeck/agentdeck.db` by default.
- Database files are restricted to the current OS user, and managed-session prompts, arguments, and environment overrides are kept in memory rather than persisted.
- Repository coordination files are stored under each repository's `.agents/` directory.
- Hook installation changes `.claude/settings.json` and optionally `~/.codex/config.toml`; backups are created before edits.
- The VS Code helper accepts only loopback `ws://` or `wss://` server URLs.
- AgentDeck does not expose a network listener to other devices by default.
- Claude Code and Codex still communicate with their respective providers according to their own configuration.

Do not expose the AgentDeck port through a public proxy unless you add appropriate authentication and understand that managed sessions provide terminal access.

## Troubleshooting

### `Node.js 20 or newer is required`

```bash
cd agentdeck
nvm use
npm install
```

### SQLite reports `NODE_MODULE_VERSION` mismatch

The native module was installed under a different Node version:

```bash
nvm use
npm rebuild better-sqlite3
```

### `Cannot check out a branch: the working tree is dirty`

Git sees modified, staged, or untracked files. Inspect them with:

```bash
git status --short
```

Keep the branch field empty, commit the work, or stash it safely before requesting a checkout.

### An external session appears even though no terminal window is visible

The CLI process may still be alive in a hidden or persistent Cursor/VS Code terminal. Open the session details and inspect its PID and TTY:

```bash
ps -p <pid> -o pid,ppid,tty,lstart,command
```

### Focus is unavailable

- Confirm macOS Automation permission.
- For Terminal.app/iTerm2, confirm the session belongs to the expected tab.
- For VS Code, install the helper and reload the VS Code window once.
- Cursor integrated terminals may remain `unknown` and cannot currently be focused.

### Repositories do not appear

- Confirm `projectsDir` is correct.
- Confirm repositories are direct children of that directory.
- Confirm each repository has a `.git` directory or `.git` worktree file.

## Development

Run the development UI and API:

```bash
nvm use
npm install
npm run dev
```

- Vite UI: [http://127.0.0.1:4040](http://127.0.0.1:4040)
- Fastify API/WebSocket server: `127.0.0.1:4041`

Validate changes:

```bash
npm test
npm run test:notch
npm run typecheck
npm run build
npm pack
```

## Contributing

Issues and pull requests are welcome.

1. Fork the repository.
2. Create a focused branch.
3. Add or update tests for behavioral changes.
4. Run the validation commands above.
5. Open a pull request describing the problem, approach, and manual testing performed.

Please avoid committing personal project names, absolute user paths, API keys, captured credentials, or real terminal/session payloads in tests, documentation, and screenshots.

## License

AgentDeck is available under the [MIT License](LICENSE).
