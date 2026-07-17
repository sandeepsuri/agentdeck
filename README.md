# AgentDeck

Local-first macOS control panel for Claude Code and Codex CLI sessions.

## Requirements

- macOS, Node.js 20 or newer, Git
- Claude Code and/or Codex CLI installed and authenticated

## Run

```bash
npm install
npm run build
npx agentdeck
```

Open <http://127.0.0.1:4040>. AgentDeck binds only to `127.0.0.1`; it is not exposed to your network.

For development, run `npm run dev` and open <http://localhost:4040>.

## Coordination and hooks

```bash
agentdeck install-hooks /path/to/repo
agentdeck install-hooks --user
agentdeck post --event claim --task FE-5 --files src/a.ts -m "starting"
```

Hook installers create timestamped backups and preserve existing Claude hooks. Existing Codex `notify` commands are chained and restored on uninstall.

macOS may ask for Automation permission to focus Terminal.app or iTerm2. If denied, discovery continues and the dashboard explains how to enable it under **System Settings → Privacy & Security → Automation**.

## Notes

- Existing terminal sessions are discovered but only AgentDeck-managed sessions expose browser terminal I/O.
- VS Code integrated terminals may be shown as terminal `unknown` and cannot be focused.
- iTerm2 support is included but was not verified on the original development machine.
- tmux persistence is planned for a later release; v0.1 uses node-pty.

## Validation

```bash
npm test
npm run typecheck
npm run build
npm pack
```
