// Shared data model used by the server, UI, and CLI.

export type AgentType = 'claude' | 'codex';
export type SessionOrigin = 'managed' | 'external';
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'waiting_input'
  | 'idle'
  | 'completed'
  | 'exited'
  | 'unknown';
export type StatusSource = 'hook' | 'output_heuristic' | 'cpu_heuristic' | 'process_gone';
export type AttentionKind = 'reply' | 'action_required' | 'response_required';
export type CompanionAgentStatus = 'action' | 'waiting' | 'reply' | 'working' | 'starting' | 'offline';

export interface DiscoveryStatus {
  running: boolean;
  polling: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  scannedProcesses: number;
  managedPids: number;
  detectedProcesses: number;
  publishedSessions: number;
}

export interface Session {
  id: string; // uuid (managed) | `ext-${pid}-${startTime}` (external)
  origin: SessionOrigin;
  agent: AgentType;
  name?: string; // user label
  taskId?: string;
  repoId?: string;
  cwd: string;
  branch?: string;
  worktreePath?: string;
  pid?: number;
  startedAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  statusSource: StatusSource;
  /**
   * ISO-8601 timestamp set once, when a managed session's process exits
   * (status becomes 'exited'). The row is kept rather than deleted so an
   * ended session survives a server restart; this is the "time it ended"
   * shown alongside it. Never set for a session that is still live.
   */
  endedAt?: string;
  /**
   * ISO-8601 timestamp set when a wrap-up summary was last (re)generated
   * for this session (ticket 11). Only ever set via the explicit
   * POST /api/sessions/:id/summarize action — never automatically. The
   * summary text itself is not stored here; it lives in
   * sessions/<id>/summary.md (src/sessions/summary.ts), read back through
   * GET /api/sessions/:id/summary.
   */
  summaryGeneratedAt?: string;
  // managed only
  backend?: 'pty' | 'tmux';
  tmuxTarget?: string;
  launchSpec?: LaunchSpec; // for restart
  // external only
  tty?: string; // e.g. ttys004
  terminalApp?: 'Terminal' | 'iTerm2' | 'VSCode' | 'unknown';
  terminalRef?: { windowId: string; tabId: string; sessionId?: string };
  // Claude session UUID / Codex thread ID emitted by the CLI hook.
  agentSessionId?: string;
}

/**
 * The Collaborator-safe projection of a Session, produced by
 * server/collaborator-session-view.ts. Declared here, beside Session, so the
 * mobile client can import the shape it actually receives rather than the
 * admin-shaped Session it does not.
 *
 * Everything that describes the operator's machine rather than the work is
 * absent by construction: cwd, worktreePath, pid, tty, terminalApp,
 * tmuxTarget, backend, launchSpec, and the agent's own CLI session id.
 */
export interface CollaboratorSession {
  id: string;
  origin: SessionOrigin;
  agent: AgentType;
  name?: string;
  /** The granted Repository this Session belongs to — the field every grant check is made against. */
  repoId: string;
  branch?: string;
  status: SessionStatus;
  statusSource: StatusSource;
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
}

/** One turn of a Session's conversation as a Collaborator sees it — never the raw bus row. */
export interface CollaboratorSessionMessage {
  ts: string;
  /** Who said it: 'human' for anything sent through AgentDeck's composer, 'agent' for the session's own output. */
  author: 'human' | 'agent';
  /** 'done' marks a completion summary, 'message' ordinary conversation. */
  event: 'message' | 'done';
  text: string;
}

export type ChatAuthorKind = 'human' | 'agent';
/** Where a posted message goes: 'chat' means every participant sees it and the agent never does; 'agent' means it was (or will be) delivered to the runtime too. */
export type ChatAudience = 'chat' | 'agent';
/** The outcome of attempting to deliver an audience:'agent' message — see docs/specs/shared-session-chat.md's "Delivery and simultaneous use". */
export type ChatDeliveryState = 'sent' | 'queued' | 'not_sent';

/**
 * One entry in a Session's shared chat feed (server/session-conversation.ts),
 * attributed to a real sender rather than collapsed into "human" — the
 * redesign this type exists for: a Session shared by several collaborators
 * previously reduced every human message to "You" (CollaboratorSessionMessage
 * above), regardless of who actually sent it.
 */
export interface SessionChatMessage {
  id: string;
  ts: string;
  authorKind: ChatAuthorKind;
  /** A named collaborator's or the local admin's Principal id — absent for the legacy shared-token path and for the agent's own turns, never guessed. */
  principalId?: string;
  displayName: string;
  /** The message exactly as its author wrote it — an @agent mention is never stripped from what other participants see, only from the delivery payload. */
  text: string;
  /** Present on human rows only. */
  audience?: ChatAudience;
  /** Present on agent rows only — 'done' marks a completion summary, 'message' ordinary conversation. */
  event?: 'message' | 'done';
  /** Present only on a human row addressed to the agent (audience: 'agent'). */
  delivery?: ChatDeliveryState;
  /** Present only when delivery is 'not_sent' — reader-facing, never an admin instruction. */
  deliveryReason?: string;
}

/**
 * One durably posted, plain-text Task/Run comment (server/run-feedback.ts,
 * docs/specs/run-feedback-review.md, B07) — deliberately parallel to
 * SessionChatMessage above but independent of it: keyed by Task rather than
 * Session, and with no runtime delivery, mention parsing, or agent-turn
 * half at all. Never routed to a runtime and never a review/approval
 * decision on its own.
 */
export interface RunFeedbackEntry {
  id: string;
  taskId: string;
  runId: string;
  sequence: number;
  postedAt: string;
  /** A named collaborator's or the local admin's Principal id — absent for the legacy shared-token path, never guessed. */
  principalId?: string;
  displayName: string;
  text: string;
}

/** Whether a Collaborator's composer can reach this Session, and why not when it cannot. */
export interface CollaboratorSessionCapabilities {
  send: 'managed' | 'queued' | 'unavailable';
  /** Present only when `send` is 'unavailable' — reader-facing, never an admin instruction. */
  reason?: string;
}

export interface LaunchSpec {
  agent: AgentType;
  cwd: string;
  initialPrompt?: string;
  /** Starting interaction mode, mapped to agent-specific CLI behavior. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  name?: string;
  branch?: string;
  /** Create the requested local branch when it does not already exist. */
  createBranchIfMissing?: boolean;
  createWorktree?: boolean;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface Repo {
  id: string;
  path: string;
  name: string; // e.g. my-app
  currentBranch?: string;
  isDirty?: boolean;
  dirtyFiles?: string[];
  worktrees?: { path: string; branch: string }[];
}

export interface Task {
  id: string;
  title: string;
  objective?: string;
  acceptanceCriteria?: string[];
  repoId?: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  dependsOn?: string[]; // task ids — readiness signalling
  sessionIds: string[];
}

// One line of .agents/bus.jsonl
export interface AgentMessage {
  ts: string; // ISO-8601
  agent: string; // "claude:sess-abc" | "codex:pid-4711" | free-form
  repo: string;
  event:
    | 'status'
    | 'claim'
    | 'release'
    | 'progress'
    | 'blocked'
    | 'done'
    | 'message'
    | 'session_start'
    | 'session_end';
  task?: string;
  status?: SessionStatus;
  files?: string[]; // paths being modified (claims)
  dependsOn?: string[];
  blockers?: string[];
  message?: string; // free text for other agents
  summary?: string; // completion summary on 'done'
  // Correlation metadata used to bind a hook event to one AgentDeck session.
  sessionId?: string; // explicit AgentDeck session id (managed sessions)
  sourcePids?: number[]; // hook process ancestry (external sessions)
  tty?: string;
  turnId?: string; // stable Claude prompt / Codex turn id for deduplication
  /** Explicit user-facing attention reason supplied by a hook when available. */
  attention?: AttentionKind;
  /** Explicit, agent-reported completion percentage. Never inferred. */
  progress?: number;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  sessionId: string;
  agent: AgentType;
  sessionName: string;
  repo: string;
  repoName: string;
  occurredAt: string;
  message?: string;
  branch?: string;
}

/** Ticket 07: a managed Run's runtime approval/input request awaiting an operator decision. */
export type RunAttentionKind = 'approval' | 'input';

export interface RunAttentionItem {
  runId: string;
  /** The stable correlation every resolve command (REST, WS, local UI, mobile UI) references — see work-engine/types.ts's RunAttentionRequest.id. */
  attentionId: string;
  objective: string;
  kind: RunAttentionKind;
  reason: string;
  requestedAt: string;
}

export interface CompanionSnapshot {
  sessions: Session[];
  attention: AttentionItem[];
  agents: CompanionAgent[];
  runAttention: RunAttentionItem[];
  uiVisible: boolean;
}

export interface CompanionAgent {
  id: string;
  agent: AgentType;
  name: string;
  repo: string;
  repoName: string;
  task: string;
  branch?: string;
  progress?: number;
  status: CompanionAgentStatus;
  updatedAt: string;
  attentionId?: string;
}

export interface FileClaim {
  // derived from bus: latest claim minus release
  repo: string;
  file: string;
  agent: string;
  task?: string;
  since: string;
}

export interface Conflict {
  kind: 'same_repo' | 'file_overlap' | 'dirty_tree' | 'dependency_wait';
  repoId: string;
  sessionIds: string[];
  files?: string[];
  detail: string;
}
