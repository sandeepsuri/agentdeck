// Shared data model — copied from DESIGN.md §6 (normative).

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
  // managed only
  backend?: 'pty' | 'tmux';
  tmuxTarget?: string;
  launchSpec?: LaunchSpec; // for restart
  // external only
  tty?: string; // e.g. ttys004
  terminalApp?: 'Terminal' | 'iTerm2' | 'unknown';
  terminalRef?: { windowId: string; tabId: string; sessionId?: string };
}

export interface LaunchSpec {
  agent: AgentType;
  cwd: string;
  initialPrompt?: string;
  name?: string;
  branch?: string;
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
