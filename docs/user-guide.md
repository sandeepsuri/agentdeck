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

## Admin and collaborator workspaces

A local, loopback connection is the **Admin** shell described in the rest of this guide: the full sidebar, every workspace view, and Settings.

A device that exchanges an invitation code becomes a named **Collaborator** instead and gets a different, repository-first workspace: a Repository drawer, a per-repository feed of Runs and Sessions, a cross-repository "Your requests" list, and a request composer. Collaborators never see the admin's Session tree, Settings, or Publication controls, and their access is limited to the Repositories and Profiles an admin explicitly grants. See [Collaborators and invitations](#collaborators-and-invitations).

## The workspace

AgentDeck keeps two kinds of sessions in the persistent session rail.

### Managed sessions

Managed sessions are launched by AgentDeck. AgentDeck owns their PTY, so you can view terminal output, type commands, resize the terminal, stop the process, and restart it from the workspace.

### Discovered sessions

Discovered sessions were started elsewhere and found through the macOS process table. AgentDeck can show their process ID, TTY, repository, branch, current status, and owning terminal when one can be identified.

Terminal.app and iTerm2 sessions can be focused through macOS Automation. VS Code terminals become focusable and scriptable after the bundled helper connects. Cursor terminals may still appear with an unknown owning terminal.

### Views

The sidebar leads with **Home**. The developer destinations (**Overview**, **Work**, **Review**, and **Usage**) sit under **Developer tools**. Repository shortcuts and Settings are below them.

- **Home** is the everyday entry point, with three sections:
  - **Ask** opens Start work with the text you type. Nothing starts until you confirm there.
  - **Needs you** is one queue of everything waiting on a human: agent permissions and questions, blocking conflicts, recent failures, crossed usage limits, and work ready for review. It is sorted by urgency, then age, and pending Run approvals and questions can be answered inline.
  - **Tasks** lists your current Runs and Sessions.

  Each section says whether it is still loading, can't be reached, or is actually empty. The Home badge in the sidebar mirrors the Needs you queue.
- **Overview** is the developer dashboard that Home used to be. It shows active work at a glance, a compact usage glance, repositories, and recently finished work. `?view=overview` opens it directly.
- **Work** lists every Run and Session together, filtered by status (All, Needs you, Working, Review, Completed, Archived), repository, agent, or search, in a **List** or **Grid** layout (remembered locally). Opening a Session shows its **Chat**, **Activity** timeline (observable actions such as reading, editing, testing, waiting and asking), and **Terminal**; opening a Run shows its detail page. Process details such as PID, TTY and origin sit under **Advanced details**. Ended Sessions older than about an hour appear under **Archived**.
- **Review** gathers work ready for review and uncommitted repository changes. A Run's review shows acceptance criteria, verification checks, files changed, and an estimated risk, with **Summary**, **Changes**, **Tests**, and **Activity** tabs, plus **Request changes**, **Approve**, and a **Ship** menu. Every ship action (apply, push, draft pull request) asks for confirmation — nothing is pushed or published without an explicit final step.
- **Usage** shows spend, tokens, plan limits and per-agent usage.

Selecting a repository in the sidebar filters Work and Review to it. Settings opens from the bottom of the sidebar; it replaces the workspace content while the sidebar stays visible, and "‹ Back to workspace" (or navigating elsewhere) returns you to what was open before. See [Settings, Profiles, and access](#settings-profiles-and-access).

Useful keyboard shortcuts:

- `⌘K` opens the command palette to search repositories, Runs, Sessions, or actions.
- `⌘L` opens **Start work**.
- `1` through `9` open the corresponding session in Work.

### Appearance and session labels

The interface follows the current macOS appearance by default. Use the top-bar appearance control to choose System, the Porcelain light theme, or the Obsidian dark theme. The preference is retained locally.

Sessions can be renamed from the inspector so long-running or similarly named work remains easy to distinguish.

## Runs

A Run is a durable unit of work with its own identity and lifecycle: it survives restarts and can use multiple Attempts or Sessions without becoming either one. Runs are distinct from the ad hoc, terminal-driven Sessions described above.

### Starting work

**＋ Start work** (sidebar, Home, or `⌘L`) is the single entry point for new work:

1. Describe what you want done.
2. Choose a **Repository** and an **Agent** (Auto, Claude, or Codex).
3. Choose a mode:
   - **Quick** launches an ad hoc coding session with your description as its first instruction, optionally on a branch. **More session options…** opens the full launcher (permission mode, environment, free path).
   - **Structured** submits a durable Run with **Acceptance criteria**, repository **verification commands**, **time and turn limits**, a base branch, and a **delivery target**: apply to the repository (default), create a branch and commit, open a draft pull request, or keep the change in AgentDeck for review. Only agents AgentDeck can currently run managed work with are used.

### Attempts, retry, pause, and resume

A Run advances through one or more **Attempts** — individual runtime executions, shown as the initial run and then **Retry #1**, **Retry #2**, and so on. Preparing a Run creates its worktree; starting it launches the first Attempt. **Retry** starts a genuinely new Attempt rather than rerunning the old one, so Run identity and history are preserved. **Pause** and **Resume** act at safe boundary points the Work Engine controls, not an arbitrary interrupt.

### Reviewing a Run

The admin Run detail page has three tabs (the **Review** destination adds the review-and-ship view described under [Views](#views)):

- **Overview** — acceptance criteria, the latest result and verification summary, a publication hint, and the feedback panel.
- **Activity** — the full history across every retry.
- **Advanced details** — the current Attempt's state and controls (start, pause, resume, retry), worktree preparation, its capability envelope, and any Sessions that happen to share the Run's prepared worktree. That correlation is read-only and advisory — starting a Run's Attempt never creates a Session, and a Session sharing the worktree is not owned by the Run.

The collaborator Run detail page is deliberately smaller, with only **Overview** (acceptance criteria, result/verification summary, feedback and review state, and preview eligibility as information only) and **Updates** (the readable progress narrative and timestamps).

### Feedback and review

Anyone with access to a Run can leave feedback through the same composer, whether admin or collaborator. Once a Run has a result, it can be marked **Reviewed** or sent back with **Request changes**. These show as derived badges — "Ready to review," "Reviewed by ‹name›," or "Changes requested by ‹name›" — rather than a stored Run status.

### Previewing a Run result

When a Run's result includes servable static HTML, a **Preview** button opens it in a new tab through a short-lived, loopback-only preview session. On the collaborator side, preview eligibility is shown for information only — there is no "Open preview" action, because that loopback listener was never authorized for collaborator access.

### Publishing a Run's result

Publishing is an explicit, admin-only step, never automatic. Once a Run completes with a delivery commit, choose **Push branch** or **Push and open draft pull request**. The publication settles as succeeded, failed (fix the cause and publish again), or ambiguous (check the remote, then reconcile and retry). This is separate from the manual **Commit staged** / **Create PR** actions in the Changes workspace described below, which act on the working tree directly and are not tied to a Run.

## Personal tasks

Personal tasks work on your own files, not on a repository. Open **Personal tasks** from the sidebar on this Mac. They are not available from a phone or to collaborators.

1. Choose **Choose a folder…**. A macOS folder dialog opens on this Mac. Pick one specific folder, such as a folder of statements. AgentDeck refuses whole-disk, home-folder, and Library selections.
2. AgentDeck lists the PDFs in that folder. Links and hidden files are skipped. Uncheck any you do not want inspected, then choose **Inspect**.
3. The task shows its activity as each file is read. When it finishes, it shows each PDF's pages, size, PDF version, and fingerprint.

AgentDeck reads the files itself. No agent sees them. Choose **Revoke access** to stop all further reads of a folder, including by a task that is already running. A task that fails, for example because the folder was moved, can be retried under the same task. If AgentDeck stops mid-task, the task runs again when AgentDeck restarts, and no result is shown until a run completes.

## Launching a managed session

Quick mode in **Start work** covers most sessions. For full control:

1. Select **Start work**, keep **Quick**, and choose **More session options…**.
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

Select a session and open **Changes**. The navigation badge shows the current number of uncommitted files in the selected repository. When a Run is selected and its worktree is ready, Changes scopes to that Run's prepared worktree instead of the repository's primary checkout.

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

## Committing and publishing from Changes

This is the manual, working-tree-driven publishing flow available from the Changes workspace for any repository. It is separate from a Run's own [publication step](#publishing-a-runs-result), which acts on a specific Run's delivery commit and is restricted to admins.

Use **Commit staged** to create a local commit from Git's staged snapshot. Partially staged and unstaged edits remain in the working tree.

Use **Create PR** to push the current branch and create a draft or ready GitHub pull request. The publishing flow checks the current branch, base branch, Git identity, remote, upstream, GitHub authentication, and existing pull requests. If a later step fails after a commit or push succeeds, retrying resumes from the failed step.

GitHub publishing requires an authenticated GitHub CLI. See [GitHub integration](integrations.md#github-cli).

## Messaging agents

Managed sessions expose their terminal directly in AgentDeck. The Sessions composer can send a response immediately or queue the next instruction without discarding terminal history.

For discovered sessions, delivery depends on the owning terminal and installed integrations:

- Terminal.app and iTerm2 sessions can receive text through macOS Automation.
- Connected VS Code terminals receive the prompt through the bundled helper.
- Claude Code in an unknown terminal can receive a queued message through hooks on the next prompt or session start.
- Codex in an unknown terminal does not currently support queued inbound delivery.

Messages sent through the workspace and supported agent replies appear in session conversation history. The chat composer's **Send to** control makes the recipient explicit: **Team** posts to everyone only, while choosing the agent adds an `@agent` mention (typing `@agent` switches the control too). Once a message reaches the agent, a "‹Agent› is working…" state stays visible until the agent replies, asks, needs approval, fails, or exits. Capturing replies and richer statuses requires the hooks described in [Integrations](integrations.md#agent-hooks).

### Answering agent questions and approvals

When Claude asks a structured question (an `AskUserQuestion` prompt) or requests a permission approval, the request appears inline in the session's shared chat as an answerable card, alongside a processing indicator ("Working…", "Waiting for your answer," "Waiting for approval," and so on). Any participant with access to the repository can answer an ordinary question; approving or denying a permission request is restricted to an authorized local admin, regardless of who is looking at the chat. Codex's `notify` hook does not currently expose structured questions or approvals, so Codex sessions show this control as unavailable.

![AgentDeck managed terminal and attention prompt with fictional output](screenshots/terminal-dark.png)

## Settings, Profiles, and access

### Settings workspace

Open **Settings** from the bottom of the sidebar. It has three tabs — **General**, **Profiles**, and **Collaborators** — that all stay mounted while you switch between them, so an unsaved draft or a one-time invitation code survives navigating away and back. General holds the default summary model, the OpenAI API key (write-only once saved), agent hook installation, and the appearance control.

### Profiles

A Profile is a reusable, admin-approved bundle of how work may run: a runtime preference, a budget, verification intent, and a requested delivery result. Profiles are how a collaborator's Run gets its settings — the Work Engine derives a collaborator-submitted Run entirely from the granted Profile, never from anything the collaborator writes directly.

Profiles cannot be edited in place. To change one, use **Create new from this Profile** to clone every field into an editable draft and save it as a new Profile. Saving offers to reassign any collaborators currently granted the original Profile to the replacement — a separate, explicit step, never automatic. This means a Profile a collaborator is actively relying on never changes underneath them.

### Collaborators and invitations

From the **Collaborators** tab, name a collaborator, choose the Repositories and Profiles to grant, and select **Create invitation**. The one-time invitation code is shown exactly once — share it out of band, since it cannot be shown again. The collaborator exchanges it for a device credential from the connection screen's "Have an invitation code instead?" option, naming their device in the process.

Each collaborator's roster entry offers **Edit access** (change their Repository and Profile grants at any time), **New device invitation** (issue another one-time code for an additional device), and **Remove** (deletes the collaborator and all of their devices, after confirmation). Individual devices can be revoked without removing the collaborator. A read-only Repository access table shows which collaborators can reach each repository.

Repository access lets a collaborator answer ordinary agent questions in shared session chat, but it never confers approval authority, access to Settings, or the ability to publish a Run's result — those remain admin-only regardless of grants.

## Native companion

The native companion starts with a production build unless `AGENTDECK_NOTCH=0` is set. It appears as one menu-bar item on notched and non-notched Macs. Click it to open a popover with monthly indexed usage, Session activity, and requests needing input.

Click the item again, click outside, or press Escape to close the popover. Use **Open Session** or **Open Run** to jump to the corresponding work. macOS may request notification permission when a Session first replies or requires input.
