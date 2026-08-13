# Coordination and Status

AgentDeck provides a repository-local coordination bus for parallel agents. It records claims, progress, blockers, messages, dependencies, and completion events without requiring a hosted service.

## Repository files

Each observed repository can contain:

```text
.agents/
├── bus.jsonl       # append-only agent events
├── inbox.jsonl     # queued dashboard-to-Claude messages
└── STATUS.md       # generated human-readable status
```

`STATUS.md` is generated from coordination events and should not be edited manually.

## Posting events

Run coordination commands from inside the relevant Git repository. AgentDeck infers the repository root from the current working directory.

Claim files before editing:

```bash
agentdeck post \
  --event claim \
  --task WEB-42 \
  --files src/components/Dashboard.tsx,src/styles/dashboard.css \
  -m "Starting dashboard work"
```

Report progress. A percentage is optional and is never inferred:

```bash
agentdeck post \
  --event progress \
  --task WEB-42 \
  --progress 65 \
  -m "Table and filters complete"
```

Report a blocker:

```bash
agentdeck post \
  --event blocked \
  --task WEB-42 \
  --blockers API-7 \
  -m "Waiting for schema"
```

Release files or complete the task:

```bash
agentdeck post --event release --task WEB-42 --files src/components/Dashboard.tsx
agentdeck post --event done --task WEB-42 -m "Dashboard complete"
```

Events appear in the workspace and trigger regeneration of `.agents/STATUS.md`.

## Session statuses

| Status | Meaning |
| --- | --- |
| `starting` | A managed CLI process has launched but is not ready yet. |
| `working` | Recent hook activity, terminal output, or sustained CPU activity indicates active work. |
| `waiting_input` | The agent is waiting for approval, input, or another user action. |
| `idle` | The process is alive but is not currently doing meaningful work. |
| `completed` | The tracked task or turn has completed. |
| `unknown` | The process is alive but AgentDeck does not have a strong status signal. |

AgentDeck combines hook events, managed terminal output, process liveness, and sustained CPU activity. Hook evidence takes precedence over output heuristics, which take precedence over CPU heuristics. Hover over a status chip to inspect the winning source.

## Attention reasons

Hook events can create three user-facing attention reasons:

- **Agent replied** — a Claude Code or Codex turn completed.
- **Action required** — an approval or permission prompt is waiting.
- **Response required** — the agent explicitly requested user input.

A newer working signal clears the previous attention item. The native companion shows attention, working, and starting sessions; inactive history remains available in the browser dashboard.

When an agent does not report `--progress`, AgentDeck displays indeterminate activity rather than inventing a completion percentage.

## Conflict warnings

Conflict warnings are derived from current repository and coordination state instead of being stored permanently:

- **same repo** — multiple active sessions share a repository.
- **file overlap** — multiple agents claim the same file.
- **dirty tree** — concurrent sessions are operating in a dirty repository.
- **dependency wait** — a task depends on another task that is not complete.

For concurrent work, prefer separate branches or Git worktrees. Automatic worktree creation is not currently available from the launch form.

![AgentDeck mission control grid with fictional parallel sessions](screenshots/mission-control-dark.png)
