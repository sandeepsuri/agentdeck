# AgentDeck Integrations

AgentDeck works without optional integrations, but terminal mapping and agent hooks provide richer focus, messaging, and status information.

## macOS terminal Automation

AgentDeck can list, focus, and type into mapped Terminal.app and iTerm2 tabs. macOS may ask whether the terminal or Node process can control those applications.

If permission was denied, open:

**System Settings → Privacy & Security → Automation**

AgentDeck continues running without Automation permission, but focus and direct messaging actions for those external terminal tabs will be unavailable.

Terminal.app support is verified. iTerm2 support is included but remains experimental.

## VS Code integrated terminals

The bundled VS Code helper reports integrated-terminal shell process IDs to AgentDeck. This lets AgentDeck focus and send prompts to the exact split terminal rather than only the owning editor window. The helper connects only to the loopback AgentDeck server.

With AgentDeck running, install the local extension through the integration endpoint:

```bash
curl -X POST http://127.0.0.1:4040/api/integrations/vscode/install
```

Reload each open VS Code window once after installation.

The installer requires the VS Code `code` shell command. If it is unavailable, open the VS Code Command Palette and run **Shell Command: Install 'code' command in PATH**.

The default helper endpoint is `ws://127.0.0.1:4040/ws`. See the [extension README](../extensions/vscode/README.md) for its package-level description.

## Agent hooks

Hooks enrich status reporting, capture supported replies, track edits, and allow queued Claude Code messages to be delivered when the owning terminal cannot be scripted.

From the workspace:

1. Select a session in the target repository.
2. Choose **Install hooks**.
3. Restart Claude Code or Codex sessions that were already running.
4. Run a turn so AgentDeck can associate the hook identity with the discovered session.

The installer adds repository-level Claude Code hooks and a user-level Codex notify command. Existing Claude hook commands are retained, timestamped backups are created before edits, and an existing Codex notify command is chained.

### CLI installation

Install Claude Code hooks for one repository:

```bash
agentdeck install-hooks /Users/you/Projects/example-app
```

Install the user-level Codex notify command:

```bash
agentdeck install-hooks --user
```

Install both at once:

```bash
agentdeck install-hooks /Users/you/Projects/example-app --user
```

Remove them symmetrically:

```bash
agentdeck uninstall-hooks /Users/you/Projects/example-app
agentdeck uninstall-hooks --user
```

Removing hooks turns off hook-driven monitoring; it does not stop any running agent process. Process discovery and CPU-based status inference continue to work.

## Terminal and messaging support

| Session location | Discovery | Focus | Direct messaging | Hook-assisted messaging |
| --- | --- | --- | --- | --- |
| AgentDeck managed PTY | Yes | In the browser | Yes | Supported |
| Terminal.app | Yes | With Automation | With Automation | Supported |
| iTerm2 | Yes | Experimental, with Automation | Experimental, with Automation | Supported |
| VS Code integrated terminal | Yes | With helper | With helper | Supported |
| Cursor integrated terminal | Usually | May be unavailable | May be unavailable | Depends on agent hooks |
| Unknown Claude Code terminal | Yes | No | No | Queued delivery on the next turn |
| Unknown Codex terminal | Yes | No | No | Inbound queued delivery unavailable |

Direct prompt delivery can work without hooks when AgentDeck can script the owning terminal. Capturing replies, edit events, and richer status changes requires hooks.

## GitHub CLI

AgentDeck uses the authenticated GitHub CLI to push branches and create pull requests. It does not store a GitHub access token.

Install and authenticate the CLI before using **Create PR**:

```bash
brew install gh
gh auth login
```

Publishing requires a GitHub repository with an `origin` remote. AgentDeck checks Git identity, authentication, upstream state, base branch, and existing pull requests before publishing.

## Optional executable override

AgentDeck normally resolves the VS Code `code` executable from `PATH`. Set `AGENTDECK_VSCODE_CLI` before starting the server only when an explicit executable path is required.
