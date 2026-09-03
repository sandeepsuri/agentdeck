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

**Run**:
A durable execution of one Task objective. A Run has its own identity and lifecycle, survives AgentDeck restarts, and may use multiple Attempts or Sessions without becoming either one.
_Avoid_: Session, provider thread, process

**Attempt**:
One runtime/process execution within a Run. Retries and runtime replacement create new Attempts while preserving the Run identity and intent.
_Avoid_: Run, Session

**Provider conversation**:
A runtime-specific conversation identity, such as a Codex thread or Claude session, kept inside its runtime adapter. It may support continuation for an Attempt but is never the AgentDeck Run identity.
_Avoid_: Run ID, AgentDeck Session

**Work specification**:
The immutable intent submitted to the Work Engine: objective, acceptance criteria, Repository, requested base reference, runtime preference, budget, verification intent, and requested delivery result.
_Avoid_: Launch specification, mutable task state

**Principal**:
The authenticated human, device, service, or runtime identity requesting an action. A transport or Session identifier is routing context, not authority.
_Avoid_: Session, channel

**Profile**:
A reusable, admin-approved configuration for how work may run, including runtime preferences, instructions, budgets, tools, and policy references. Profiles reference secrets but never contain secret values.
_Avoid_: Work specification, runtime credentials

**Policy decision**:
The durable result of evaluating a Principal's requested action and context: allow, deny, or require approval, with a stable rule identifier and human-readable reason.
_Avoid_: Capability, approval

**Capability envelope**:
The effective, frozen limits granted to a Run or Attempt, such as filesystem roots, network domains, environment policy, process ceilings, and child-Run ceilings.
_Avoid_: Profile, runtime feature list

**Approval**:
A durable, correlated request and explicit resolution authorizing or denying a particular gated action. An approval never grants broader authority than the action it names.
_Avoid_: Input response, policy rule

**Verification gate**:
A configured check whose recorded evidence must satisfy the Run's verification intent before the Run may advance or complete.
_Avoid_: Runtime status, informal test output

**Run result**:
The durable terminal record of a Run's outcome, including its submitted intent, delivery artifacts, verification evidence, approvals, usage, budget state, and recovery notes.
_Avoid_: Session summary, terminal transcript

**Invitation**:
A one-time code the bootstrap local admin issues for a named collaborator, exchanged exactly once for a Device credential. An invitation grants no authority itself — it only proves the exchange happened.
_Avoid_: Token, access code

**Device credential**:
An individually revocable bearer credential bound to one collaborator's device, minted by exchanging an Invitation. Authenticates a remote request to a Principal and device for audit attribution; stored only as a hash, never in a form that reveals the bearer value after issuance.
_Avoid_: Token, session, API key

**Publication**:
An explicit, durable, admin-authorized intent to push a Run's local delivery commit — and optionally open a draft pull request — to a Repository's remote, persisted before execution with a stable identity and settled as succeeded, failed, or ambiguous. Never created automatically by local Run completion, and never granted to a collaborator.
_Avoid_: Deploy, release, publish (as a bare verb with no durable record)
