# AgentDeck

AgentDeck is a local-first control panel for supervising Claude Code and Codex work across repositories without replacing either agent's own runtime.

## Language

**Session**:
A running Claude Code or Codex process that AgentDeck can observe. A session may be managed or external.
_Avoid_: Agent, task

**Managed session**:
A session launched by AgentDeck whose terminal lifecycle AgentDeck owns.
_Avoid_: Internal session

**External session**:
A session launched outside AgentDeck and discovered from its local process and terminal metadata.
_Avoid_: Unmanaged agent

**Task**:
A unit of work recorded for coordination. Tasks may declare dependencies on other tasks and may be associated with sessions.
_Avoid_: Session, job

**Attention**:
A derived indication that a session may need human input, such as an approval or reply.
_Avoid_: Notification, alert

**Claim**:
A session's declaration that it is working on a file or area of a repository.
_Avoid_: Lock, ownership

**Dependency**:
A blocking relationship in which one task cannot proceed until another task reaches the required state.
_Avoid_: Claim

**Conflict**:
A derived warning that concurrent work may overlap or otherwise interfere. A conflict is advisory and is not a lock.
_Avoid_: Collision, merge conflict

**Launch specification**:
The in-memory instructions needed to start or restart a managed session, including its command, arguments, initial prompt, and environment overrides.
_Avoid_: Launch manifest

**Repository**:
A Git working tree known to AgentDeck and used as the security boundary for repository-scoped actions.
_Avoid_: Project, workspace
