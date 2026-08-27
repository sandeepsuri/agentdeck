---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

For AgentDeck, read `CONTEXT.md`, `docs/architecture.md`, and `docs/development.md` first. Run `nvm use`; the repository's `.nvmrc` is authoritative for project commands.

Use /tdd where possible, at pre-agreed seams.

Run focused Vitest files and `npm run typecheck` regularly, then `npm test` once at the end. Run `npm run test:notch` for native companion changes and `npm run build` when the change affects packaging or cross-runtime integration.

Preserve AgentDeck's loopback-only listeners, repository path confinement, and exclusion of launch secrets from browser-visible and persisted state.

Once done, use /code-review to review the work.

Commit only when the user has asked for a commit or the originating spec workflow explicitly requires one.
