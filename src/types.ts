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

export interface CompanionSnapshot {
  sessions: Session[];
  attention: AttentionItem[];
  agents: CompanionAgent[];
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
