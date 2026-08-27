# Issue Tracker

AgentDeck uses GitHub Issues in the repository addressed by the current `origin` remote. Resolve the remote at runtime; do not hardcode a fork or owner.

- Read and publish issues with the connected GitHub tooling or `gh` when authenticated.
- Preserve the user's issue templates, labels, milestones, and parent relationships.
- Use the `ready-for-agent` label when a workflow calls for it and the label already exists. If it does not exist, ask before creating repository metadata.
- Use native sub-issue or blocking relationships when available. Otherwise record blocking issue references in the issue body.
- Never close or rewrite a parent issue unless the user explicitly asks.
- Draft issue content from repository evidence and show it before publishing when the user's request did not already authorize publication.
