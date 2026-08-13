# AgentDeck User Guide

This guide covers day-to-day use of AgentDeck. For installation, start with the [root README](../README.md). Integration-specific setup is documented separately in [Integrations](integrations.md).

## Repository discovery

AgentDeck scans exactly one directory level for Git repositories and linked worktrees. Without a configuration file, it derives the projects directory from where it was started:

- When started inside a Git repository, it scans that repository's parent directory.
- When started elsewhere, it scans the current directory.

To use a fixed projects directory, create `~/.agentdeck/config.json`:

```json
{
  "port": 4040,
  "projectsDir": "/Users/you/Projects",
  "pollIntervalMs": 5000,
  "dataDir": "/Users/you/.agentdeck"
}
```

Restart AgentDeck after changing the file. Missing or invalid values fall back to their defaults.

## The workspace

AgentDeck keeps two kinds of sessions in the persistent session rail.

### Managed sessions

Managed sessions are launched by AgentDeck. AgentDeck owns their PTY, so you can view terminal output, type commands, resize the terminal, stop the process, and restart it from the workspace.

### Discovered sessions

Discovered sessions were started elsewhere and found through the macOS process table. AgentDeck can show their process ID, TTY, repository, branch, current status, and owning terminal when one can be identified.

Terminal.app and iTerm2 sessions can be focused through macOS Automation. VS Code terminals become focusable and scriptable after the bundled helper connects. Cursor terminals may still appear with an unknown owning terminal.

### Views

- **Operations** groups active work by repository and surfaces attention prompts, process activity, working-tree health, and conflict warnings.
- **Terminal** hosts the managed PTY or focus and messaging controls for an external terminal. Managed terminals stay mounted while switching views, preserving their connection and history.
- **Changes** provides repository-wide code review, staging, editor, commit, and publishing actions.
- **Grid** presents recent output from every session in a terminal-style mission control view.

Useful keyboard shortcuts:

- `⌘K` opens the command palette.
- `⌘L` opens the launch manifest.
- `1` through `9` select the corresponding visible session.

### Appearance and session labels

The interface follows the current macOS appearance by default. Use the top-bar appearance control to choose System, the Porcelain light theme, or the Obsidian dark theme. The preference is retained locally.

Sessions can be renamed from the inspector so long-running or similarly named work remains easy to distinguish.

## Launching a managed agent

1. Select **Launch agent**.
2. Choose Claude Code or Codex CLI.
3. Select a scanned repository or enter a free path.
4. Optionally set a session name, branch, and initial objective.
5. Enable **Create branch if missing** when a new branch is required.
6. Choose Ask, Auto-edit, or Plan permission mode.
7. Add environment variables individually or import a local `.env` file for the launched agent.
8. Review the command preview and preflight checks.
9. Select **Initialize session** or press `⌘Enter`.

AgentDeck checks the directory, Git repository, branch, agent CLI, and PTY immediately before launch. It refuses to switch branches when the working tree contains modified, staged, or untracked files. Leave the branch field empty to keep the current branch.

Imported environment values are passed to the launched session; AgentDeck itself does not require a project `.env` file.

![AgentDeck launch manifest and preflight checks with fictional data](screenshots/launcher-dark.png)

## Stopping and restarting sessions

To stop a managed agent, select the session and choose **Stop** in the inspector. AgentDeck sends `SIGTERM` and escalates to `SIGKILL` only when necessary.

Choose **Restart** to relaunch the stored specification with the same label and working directory.

AgentDeck does not own discovered processes and therefore does not offer a stop action for them. Focus the owning terminal and use `Ctrl+C`, followed by `exit` if you also want to close the shell.

If the terminal cannot be focused, verify the displayed process before stopping it manually:

```bash
ps -p <pid> -o pid,tty,command
kill <pid>
```

Avoid broad commands such as `pkill claude` or `pkill codex`, which can terminate unrelated sessions.

## Reviewing code changes

Select a session and open **Changes**. The navigation badge shows the current number of uncommitted files in the selected repository.

The viewer supports two scopes:

- **Uncommitted** combines staged, unstaged, and untracked working-tree changes.
- **vs base branch** shows committed changes since the current branch diverged from its base. AgentDeck resolves the base from `origin/HEAD`, then falls back to `main` or `master`.

The file rail separates modified and untracked files, shows line counts, and includes active agent claims. Select a file to:

- Review a unified or split diff
- Ignore whitespace changes
- Stage or unstage the file
- Discard the file after confirmation
- Mark it reviewed
- Open it through the VS Code CLI

Binary files are identified without rendering their contents. Text diffs are limited to the first 512 KB. Summaries and open diffs refresh every five seconds so changes can be followed as an agent works.

![AgentDeck Changes workspace in the Porcelain theme](screenshots/changes-light.png)

## Committing and publishing

Use **Commit staged** to create a local commit from Git's staged snapshot. Partially staged and unstaged edits remain in the working tree.

Use **Create PR** to push the current branch and create a draft or ready GitHub pull request. The publishing flow checks the current branch, base branch, Git identity, remote, upstream, GitHub authentication, and existing pull requests. If a later step fails after a commit or push succeeds, retrying resumes from the failed step.

GitHub publishing requires an authenticated GitHub CLI. See [GitHub integration](integrations.md#github-cli).

## Messaging agents

Managed sessions expose their terminal directly in AgentDeck. The Terminal composer can send a response immediately or queue the next instruction without discarding terminal history.

For discovered sessions, delivery depends on the owning terminal and installed integrations:

- Terminal.app and iTerm2 sessions can receive text through macOS Automation.
- Connected VS Code terminals receive the prompt through the bundled helper.
- Claude Code in an unknown terminal can receive a queued message through hooks on the next prompt or session start.
- Codex in an unknown terminal does not currently support queued inbound delivery.

Messages sent through the workspace and supported agent replies appear in session conversation history. Capturing replies and richer statuses requires the hooks described in [Integrations](integrations.md#agent-hooks).

![AgentDeck managed terminal and attention prompt with fictional output](screenshots/terminal-dark.png)

## Native companion

The native companion starts with a production build unless `AGENTDECK_NOTCH=0` is set. On a notched MacBook it appears around the camera housing; on other displays it falls back to a menu-bar pill and detached panel.

Hover to inspect active agents, pin the expanded view, or use **Open Session** to jump to the corresponding terminal. macOS may request notification permission when an agent first replies or requires approval.
