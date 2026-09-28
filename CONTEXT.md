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

**Needs You**:
The single, derived queue of every Attention-bearing item across Runs, Sessions, conflicts, failures, review-ready results, and crossed usage limits, ordered by urgency then age. It is the one source for the Home queue, the sidebar badge, and the Work "Needs you" filter.
_Avoid_: Inbox, notifications

**Work**:
The people-facing name for a Run or Session in the interface. Work is a presentation concept only; Run, Attempt, and Session keep their meanings internally, and an Attempt appears to people as "Retry #n".
_Avoid_: Job, operation

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

**Personal task**:
Durable owner work on personal files, such as inventorying PDFs in a granted folder. It keeps one identity across restarts and Attempts and records who asked, from which device, the Folder grant, and the policy version it ran under. It is never a Run or Session, and a collaborator can neither see nor submit one.
_Avoid_: Run, job

**Folder grant**:
One folder the owner picked in the native picker on this Mac, stored by canonical path. Every read re-checks that the path is inside the folder and follows no symlink. Revoking the grant stops any further reads, including by a task already running.
_Avoid_: Permission, workspace, Repository

**Filing proposal**:
A Personal task whose result is a reviewable plan to rename and file granted PDFs: for each source, its content digest, new name, destination folder, and any overwrite, duplicate, or new-folder warning. It is built only from typed requests the confined agent made through the broker, which AgentDeck validated, and it carries a plan digest that changes whenever the plan does. A proposal moves nothing.
_Avoid_: Filing plan approval, move job

**Filing approval**:
The owner's approval of one exact Filing proposal, bound to its plan digest, the approving owner, an expiry, and a single initial execution, with an explicit choice for each target it would replace. AgentDeck's own code, never an agent, then moves each file after re-checking the grant, links, and content on disk, and keeps a durable receipt per file: moved, left in place, not moved, or uncertain. Approving again returns the approval on record. A later owner-requested retry uses a durable idempotency key and only receipts recorded as not moved; a settled move is never repeated, even across a restart. Undo restores a recorded move only when the original name is free and the destination still has the recorded file identity.
_Avoid_: Move job, batch rename, filing run

**Email account grant**:
One Gmail account the owner connected on this Mac through Google's consent, with permission to read mail and manage drafts only. AgentDeck keeps the address, the granted scopes, and the last check with a repair state; the sign-in itself stays in the owner's login Keychain. Revoking it stops any further search or draft write and forgets the sign-in here and at Google.
_Avoid_: Mailbox connection, email login, Folder grant

**Email reply task**:
A Personal task that asks the confined agent to find one message in an Email account grant and suggest a reply. The agent reaches mail only through the broker, sees only messages its own searches returned, and proposes only reply text; AgentDeck chooses recipients and subject from the message. The owner confirms the match from headers and text AgentDeck read itself.
_Avoid_: Email job, inbox run

**Reply draft**:
The editable reply AgentDeck writes to the owner's Gmail drafts after the match is confirmed. Every save is a durable version recorded before the one provider write and settled from what Gmail reads back, so each version shows exactly the recipients, subject, body, and attachments Gmail holds, and a lost response never produces a second draft. A reply draft is never sent by preparing or editing it.
_Avoid_: Proposal (for the draft itself), outbox, message

**Reply send**:
The owner's approval of one saved Reply draft version, bound to its version and digest, and the single Gmail send it allows. AgentDeck records the approval, with exactly the content approved and a fresh send intent, before the send, and builds the message from that record rather than from whatever the Gmail draft holds by then. It is settled as sent, failed (not sent), expired, or ambiguous; an ambiguous send is settled from the thread's sent mail by its intent before anything is sent again. Any later edit needs a new approval, and only the owner at this Mac can approve.
_Avoid_: Auto-send, outbox, standing approval

**Provider readiness**:
The result of a harmless check that a provider CLI on this Mac is installed, signed in with the provider's own sign-in, and within its plan allowance: ready, missing CLI, signed out, expired, allowance reached, or check failed, each with repair steps. Only this metadata is kept; the credential stays in the provider's own storage.
_Avoid_: Runtime readiness (the managed-run capability probe), login, auth

**Publication**:
An explicit, durable, admin-authorized intent to push a Run's local delivery commit — and optionally open a draft pull request — to a Repository's remote, persisted before execution with a stable identity and settled as succeeded, failed, or ambiguous. Never created automatically by local Run completion, and never granted to a collaborator.
_Avoid_: Deploy, release, publish (as a bare verb with no durable record)
