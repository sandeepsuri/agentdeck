// Persistence layer (T2): single-file SQLite via better-sqlite3.
// Repository pattern: everything the rest of the app needs goes through the
// typed methods on Store — no SQL outside this directory.
import DatabaseCtor, { type Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage, Repo, Session, Task } from '../types.js';
import { migrate } from './migrate.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

// --- row mapping helpers -----------------------------------------------------

const toJson = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const fromJson = <T>(v: unknown): T | undefined =>
  typeof v === 'string' ? (JSON.parse(v) as T) : undefined;
// SQLite has no undefined; normalize nulls back out when hydrating.
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

interface SessionRow {
  id: string; origin: string; agent: string; name: string | null; task_id: string | null;
  repo_id: string | null; cwd: string; branch: string | null; worktree_path: string | null;
  pid: number | null; started_at: string; last_activity_at: string; status: string;
  status_source: string; backend: string | null; tmux_target: string | null;
  launch_spec: string | null; tty: string | null; terminal_app: string | null;
  terminal_ref: string | null; agent_session_id: string | null; ended_at: string | null;
}

function rowToSession(r: SessionRow): Session {
  const s: Session = {
    id: r.id,
    origin: r.origin as Session['origin'],
    agent: r.agent as Session['agent'],
    cwd: r.cwd,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    status: r.status as Session['status'],
    statusSource: r.status_source as Session['statusSource'],
  };
  if (r.name !== null) s.name = r.name;
  if (r.task_id !== null) s.taskId = r.task_id;
  if (r.repo_id !== null) s.repoId = r.repo_id;
  if (r.branch !== null) s.branch = r.branch;
  if (r.worktree_path !== null) s.worktreePath = r.worktree_path;
  if (r.pid !== null) s.pid = r.pid;
  if (r.backend !== null) s.backend = r.backend as Session['backend'];
  if (r.tmux_target !== null) s.tmuxTarget = r.tmux_target;
  const launchSpec = fromJson<Session['launchSpec']>(r.launch_spec);
  if (launchSpec !== undefined) s.launchSpec = launchSpec;
  if (r.tty !== null) s.tty = r.tty;
  if (r.terminal_app !== null) s.terminalApp = r.terminal_app as Session['terminalApp'];
  const terminalRef = fromJson<Session['terminalRef']>(r.terminal_ref);
  if (terminalRef !== undefined) s.terminalRef = terminalRef;
  if (r.agent_session_id !== null) s.agentSessionId = r.agent_session_id;
  if (r.ended_at !== null) s.endedAt = r.ended_at;
  return s;
}

interface TaskRow {
  id: string; title: string; repo_id: string | null; status: string;
  depends_on: string | null; session_ids: string;
}

function rowToTask(r: TaskRow): Task {
  const t: Task = {
    id: r.id,
    title: r.title,
    status: r.status as Task['status'],
    sessionIds: fromJson<string[]>(r.session_ids) ?? [],
  };
  if (r.repo_id !== null) t.repoId = r.repo_id;
  const dependsOn = fromJson<string[]>(r.depends_on);
  if (dependsOn !== undefined) t.dependsOn = dependsOn;
  return t;
}

interface RepoRow {
  id: string; path: string; name: string; current_branch: string | null;
  is_dirty: number | null; dirty_files: string | null; worktrees: string | null;
}

function rowToRepo(r: RepoRow): Repo {
  const repo: Repo = { id: r.id, path: r.path, name: r.name };
  if (r.current_branch !== null) repo.currentBranch = r.current_branch;
  if (r.is_dirty !== null) repo.isDirty = r.is_dirty === 1;
  const dirtyFiles = fromJson<string[]>(r.dirty_files);
  if (dirtyFiles !== undefined) repo.dirtyFiles = dirtyFiles;
  const worktrees = fromJson<Repo['worktrees']>(r.worktrees);
  if (worktrees !== undefined) repo.worktrees = worktrees;
  return repo;
}

// --- store -------------------------------------------------------------------

export interface StoredEvent extends AgentMessage {
  /** archive row id (insertion order) */
  eventId: number;
}

export class Store {
  private db: Database;

  /** @param dbPath file path, or ':memory:' (tests) */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      // launch metadata and archived messages can be sensitive. Pre-create
      // and normalize the database mode instead of relying on the user's umask.
      fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
      fs.chmodSync(dbPath, 0o600);
    }
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    if (dbPath !== ':memory:') {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      }
    }
    migrate(this.db, MIGRATIONS_DIR);
  }

  close(): void {
    this.db.close();
  }

  // -- sessions --

  upsertSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, origin, agent, name, task_id, repo_id, cwd, branch,
           worktree_path, pid, started_at, last_activity_at, status, status_source,
           backend, tmux_target, launch_spec, tty, terminal_app, terminal_ref,
           agent_session_id, ended_at)
         VALUES (@id, @origin, @agent, @name, @taskId, @repoId, @cwd, @branch,
           @worktreePath, @pid, @startedAt, @lastActivityAt, @status, @statusSource,
           @backend, @tmuxTarget, @launchSpec, @tty, @terminalApp, @terminalRef,
           @agentSessionId, @endedAt)
         ON CONFLICT(id) DO UPDATE SET
           origin=excluded.origin, agent=excluded.agent, name=excluded.name,
           task_id=excluded.task_id, repo_id=excluded.repo_id, cwd=excluded.cwd,
           branch=excluded.branch, worktree_path=excluded.worktree_path,
           pid=excluded.pid, started_at=excluded.started_at,
           last_activity_at=excluded.last_activity_at, status=excluded.status,
           status_source=excluded.status_source, backend=excluded.backend,
           tmux_target=excluded.tmux_target, launch_spec=excluded.launch_spec,
           tty=excluded.tty, terminal_app=excluded.terminal_app,
           terminal_ref=excluded.terminal_ref,
           agent_session_id=excluded.agent_session_id, ended_at=excluded.ended_at`,
      )
      .run({
        id: s.id,
        origin: s.origin,
        agent: s.agent,
        name: s.name ?? null,
        taskId: s.taskId ?? null,
        repoId: s.repoId ?? null,
        cwd: s.cwd,
        branch: s.branch ?? null,
        worktreePath: s.worktreePath ?? null,
        pid: s.pid ?? null,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        status: s.status,
        statusSource: s.statusSource,
        backend: s.backend ?? null,
        tmuxTarget: s.tmuxTarget ?? null,
        launchSpec: toJson(s.launchSpec),
        tty: s.tty ?? null,
        terminalApp: s.terminalApp ?? null,
        terminalRef: toJson(s.terminalRef),
        agentSessionId: s.agentSessionId ?? null,
        endedAt: s.endedAt ?? null,
      });
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // -- tasks --

  saveTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, repo_id, status, depends_on, session_ids)
         VALUES (@id, @title, @repoId, @status, @dependsOn, @sessionIds)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, repo_id=excluded.repo_id, status=excluded.status,
           depends_on=excluded.depends_on, session_ids=excluded.session_ids`,
      )
      .run({
        id: t.id,
        title: t.title,
        repoId: t.repoId ?? null,
        status: t.status,
        dependsOn: toJson(t.dependsOn),
        sessionIds: JSON.stringify(t.sessionIds),
      });
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks').all() as TaskRow[]).map(rowToTask);
  }

  // -- repos --

  upsertRepo(r: Repo): void {
    this.db
      .prepare(
        `INSERT INTO repos (id, path, name, current_branch, is_dirty, dirty_files, worktrees)
         VALUES (@id, @path, @name, @currentBranch, @isDirty, @dirtyFiles, @worktrees)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path, name=excluded.name, current_branch=excluded.current_branch,
           is_dirty=excluded.is_dirty, dirty_files=excluded.dirty_files,
           worktrees=excluded.worktrees`,
      )
      .run({
        id: r.id,
        path: r.path,
        name: r.name,
        currentBranch: r.currentBranch ?? null,
        isDirty: r.isDirty === undefined ? null : r.isDirty ? 1 : 0,
        dirtyFiles: toJson(r.dirtyFiles),
        worktrees: toJson(r.worktrees),
      });
  }

  listRepos(): Repo[] {
    return (this.db.prepare('SELECT * FROM repos ORDER BY name').all() as RepoRow[]).map(rowToRepo);
  }

  // -- events archive --

  appendEvent(m: AgentMessage): number {
    const info = this.db
      .prepare('INSERT INTO events (ts, agent, repo, event, payload) VALUES (?, ?, ?, ?, ?)')
      .run(m.ts, m.agent, m.repo, m.event, JSON.stringify(m));
    return Number(info.lastInsertRowid);
  }

  listEvents(opts: { repo?: string; limit?: number } = {}): StoredEvent[] {
    const limit = opts.limit ?? 1000;
    const rows = (
      opts.repo !== undefined
        ? this.db
            .prepare('SELECT id, payload FROM events WHERE repo = ? ORDER BY id DESC LIMIT ?')
            .all(opts.repo, limit)
        : this.db.prepare('SELECT id, payload FROM events ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; payload: string }[];
    return rows
      .map((r) => ({ ...(JSON.parse(r.payload) as AgentMessage), eventId: r.id }))
      .reverse(); // chronological
  }

  // -- settings --

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }
}

/** Open (and migrate) the store at the standard location for a config. */
export function openStore(dataDir: string): Store {
  return new Store(path.join(dataDir, 'agentdeck.db'));
}
