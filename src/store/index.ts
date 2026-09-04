// Persistence layer (T2): single-file SQLite via better-sqlite3.
// Repository pattern: everything the rest of the app needs goes through the
// typed methods on Store — no SQL outside this directory.
import DatabaseCtor, { type Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage, AgentType, Repo, Session, Task } from '../types.js';
import { deriveOpenAttentionRequest, deriveRunStatus, projectAttemptState } from '../work-engine/attempt-projection.js';
import type { AttemptEventEnvelope } from '../work-engine/durable-events.js';
import type {
  AttemptEvent, Profile, RepositoryVerificationPolicy, RunActivity, RunActivityKind, RunActorDevice, RunEnvelopeState,
  RunPreparation, RunPrincipal, RunPublication, RunPublicationResult, RunVerificationPolicyState, WorkRun, WorkSpec,
} from '../work-engine/types.js';
import { migrate } from './migrate.js';
import type {
  CollaboratorRow, CollaboratorStore, DeviceRow, InvitationRow,
} from '../collaborators/service.js';

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
  summary_generated_at: string | null;
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
  if (r.summary_generated_at !== null) s.summaryGeneratedAt = r.summary_generated_at;
  return s;
}

interface TaskRow {
  id: string; title: string; repo_id: string | null; status: string;
  depends_on: string | null; session_ids: string; objective: string | null;
  acceptance_criteria: string | null;
}

function rowToTask(r: TaskRow): Task {
  const t: Task = {
    id: r.id,
    title: r.title,
    status: r.status as Task['status'],
    sessionIds: fromJson<string[]>(r.session_ids) ?? [],
  };
  if (r.objective !== null) t.objective = r.objective;
  const acceptanceCriteria = fromJson<string[]>(r.acceptance_criteria);
  if (acceptanceCriteria !== undefined) t.acceptanceCriteria = acceptanceCriteria;
  if (r.repo_id !== null) t.repoId = r.repo_id;
  const dependsOn = fromJson<string[]>(r.depends_on);
  if (dependsOn !== undefined) t.dependsOn = dependsOn;
  return t;
}

interface RunRow {
  id: string; task_id: string; status: string; work_spec: string; submitted_at: string;
  preparation: string; envelope: string; verification_policy: string; principal: string;
}

interface AttemptRow {
  id: string; runtime: string; started_at: string;
}

/**
 * A Run before its Attempt is folded in. `status` here is raw — see
 * Store.attachAttempt/deriveRunStatus: the 'running'/'completed'/'failed'
 * half of RunStatus is never trusted from this row alone, so a crash
 * between an Attempt's terminal event persisting and any status write can
 * never leave the two disagreeing.
 */
type RawRun = Omit<WorkRun, 'status' | 'attempt'> & { status: string };

function rowToRun(r: RunRow): RawRun {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status,
    spec: JSON.parse(r.work_spec) as WorkSpec,
    submittedAt: r.submitted_at,
    preparation: JSON.parse(r.preparation) as RunPreparation,
    envelope: JSON.parse(r.envelope) as RunEnvelopeState,
    verificationPolicy: JSON.parse(r.verification_policy) as RunVerificationPolicyState,
    principal: JSON.parse(r.principal) as RunPrincipal,
  };
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

interface CollaboratorTableRow {
  id: string; display_name: string; created_at: string; granted_repository_ids: string; granted_profile_ids: string;
}

function rowToCollaborator(r: CollaboratorTableRow): CollaboratorRow {
  return {
    id: r.id, displayName: r.display_name, createdAt: r.created_at,
    grantedRepositoryIds: fromJson<string[]>(r.granted_repository_ids) ?? [],
    grantedProfileIds: fromJson<string[]>(r.granted_profile_ids) ?? [],
  };
}

interface InvitationTableRow {
  id: string; collaborator_id: string; created_at: string; expires_at: string; consumed_at: string | null;
}

function rowToInvitation(r: InvitationTableRow): InvitationRow {
  const invitation: InvitationRow = {
    id: r.id, collaboratorId: r.collaborator_id, createdAt: r.created_at, expiresAt: r.expires_at,
  };
  if (r.consumed_at !== null) invitation.consumedAt = r.consumed_at;
  return invitation;
}

interface DeviceTableRow {
  id: string; collaborator_id: string; device_label: string; created_at: string; revoked_at: string | null;
}

function rowToDevice(r: DeviceTableRow): DeviceRow {
  const device: DeviceRow = {
    id: r.id, collaboratorId: r.collaborator_id, deviceLabel: r.device_label, createdAt: r.created_at,
  };
  if (r.revoked_at !== null) device.revokedAt = r.revoked_at;
  return device;
}

interface ProfileTableRow {
  id: string; name: string; runtime_preference: string; budget: string; verification_intent: string;
  requested_delivery_result: string; created_at: string;
}

function rowToProfile(r: ProfileTableRow): Profile {
  return {
    id: r.id,
    name: r.name,
    runtimePreference: JSON.parse(r.runtime_preference) as Profile['runtimePreference'],
    budget: JSON.parse(r.budget) as Profile['budget'],
    verificationIntent: JSON.parse(r.verification_intent) as Profile['verificationIntent'],
    requestedDeliveryResult: r.requested_delivery_result as Profile['requestedDeliveryResult'],
    createdAt: r.created_at,
  };
}

interface RunActivityTableRow {
  id: string; run_id: string; kind: string; principal: string; device: string | null; at: string;
}

function rowToRunActivity(r: RunActivityTableRow): RunActivity {
  const activity: RunActivity = {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as RunActivityKind,
    principal: JSON.parse(r.principal) as RunPrincipal,
    at: r.at,
  };
  const device = fromJson<RunActorDevice>(r.device);
  return device !== undefined ? { ...activity, device } : activity;
}

interface RunPublicationTableRow {
  id: string; run_id: string; idempotency_key: string; target: string; commit_sha: string; branch: string;
  state: string; authorized_by: string; authorized_at: string; updated_at: string; executions: number;
  result: string | null; reason: string | null;
}

function rowToRunPublication(r: RunPublicationTableRow): RunPublication {
  const publication: RunPublication = {
    id: r.id,
    runId: r.run_id,
    idempotencyKey: r.idempotency_key,
    target: r.target as RunPublication['target'],
    commit: r.commit_sha,
    branch: r.branch,
    state: r.state as RunPublication['state'],
    authorizedBy: JSON.parse(r.authorized_by) as RunPrincipal,
    authorizedAt: r.authorized_at,
    updatedAt: r.updated_at,
    executions: r.executions,
  };
  const result = fromJson<RunPublicationResult>(r.result);
  return {
    ...publication,
    ...(result !== undefined ? { result } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
  };
}

// --- store -------------------------------------------------------------------

export interface StoredEvent extends AgentMessage {
  /** archive row id (insertion order) */
  eventId: number;
}

export class Store implements CollaboratorStore {
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
           agent_session_id, ended_at, summary_generated_at)
         VALUES (@id, @origin, @agent, @name, @taskId, @repoId, @cwd, @branch,
           @worktreePath, @pid, @startedAt, @lastActivityAt, @status, @statusSource,
           @backend, @tmuxTarget, @launchSpec, @tty, @terminalApp, @terminalRef,
           @agentSessionId, @endedAt, @summaryGeneratedAt)
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
           agent_session_id=excluded.agent_session_id, ended_at=excluded.ended_at,
           summary_generated_at=excluded.summary_generated_at`,
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
        summaryGeneratedAt: s.summaryGeneratedAt ?? null,
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
        `INSERT INTO tasks (id, title, objective, acceptance_criteria, repo_id, status, depends_on, session_ids)
         VALUES (@id, @title, @objective, @acceptanceCriteria, @repoId, @status, @dependsOn, @sessionIds)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, objective=excluded.objective,
           acceptance_criteria=excluded.acceptance_criteria,
           repo_id=excluded.repo_id, status=excluded.status,
           depends_on=excluded.depends_on, session_ids=excluded.session_ids`,
      )
      .run({
        id: t.id,
        title: t.title,
        objective: t.objective ?? null,
        acceptanceCriteria: toJson(t.acceptanceCriteria),
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

  // -- durable work runs --

  createTaskAndRun(task: Task, run: WorkRun): void {
    this.db.transaction(() => {
      this.saveTask(task);
      this.db.prepare(
        `INSERT INTO runs (id, task_id, status, work_spec, submitted_at, preparation, envelope, verification_policy, principal)
         VALUES (@id, @taskId, @status, @workSpec, @submittedAt, @preparation, @envelope, @verificationPolicy, @principal)`,
      ).run({
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        workSpec: JSON.stringify(run.spec),
        submittedAt: run.submittedAt,
        preparation: JSON.stringify(run.preparation),
        envelope: JSON.stringify(run.envelope),
        verificationPolicy: JSON.stringify(run.verificationPolicy),
        principal: JSON.stringify(run.principal),
      });
    })();
  }

  getRun(id: string): WorkRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? this.attachAttempt(rowToRun(row)) : undefined;
  }

  listRuns(): WorkRun[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY submitted_at DESC').all() as RunRow[])
      .map((row) => this.attachAttempt(rowToRun(row)));
  }

  /** Updates a Run's status, preparation, envelope, and verification policy. The frozen spec never changes; Attempt state is durable elsewhere (see appendAttemptEvent). */
  updateRun(run: Pick<WorkRun, 'id' | 'status' | 'preparation' | 'envelope' | 'verificationPolicy'>): void {
    this.db.prepare(
      `UPDATE runs SET status = @status, preparation = @preparation, envelope = @envelope,
         verification_policy = @verificationPolicy WHERE id = @id`,
    ).run({
      id: run.id,
      status: run.status,
      preparation: JSON.stringify(run.preparation),
      envelope: JSON.stringify(run.envelope),
      verificationPolicy: JSON.stringify(run.verificationPolicy),
    });
  }

  // -- durable Attempt event log (ticket 06) --

  /** Records the one piece of Attempt metadata that isn't itself an event: which runtime, started when. Call once, before the first event. */
  startAttempt(record: { id: string; runId: string; runtime: AgentType; startedAt: string }): void {
    this.db.prepare(
      'INSERT INTO attempts (id, run_id, runtime, started_at) VALUES (@id, @runId, @runtime, @startedAt)',
    ).run(record);
  }

  /** Idempotent: an envelope whose dedupeKey already exists for this Attempt is silently dropped — a redelivered provider event never duplicates durable history. */
  appendAttemptEvent(envelope: AttemptEventEnvelope): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO attempt_events
         (attempt_id, sequence, correlation_id, dedupe_key, schema_version, durability, at, payload)
       VALUES (@attemptId, @sequence, @correlationId, @dedupeKey, @schemaVersion, @durability, @at, @payload)`,
    ).run({
      attemptId: envelope.attemptId,
      sequence: envelope.sequence,
      correlationId: envelope.correlationId,
      dedupeKey: envelope.dedupeKey,
      schemaVersion: envelope.schemaVersion,
      durability: envelope.durability,
      at: envelope.at,
      payload: JSON.stringify(envelope.event),
    });
  }

  /** The attemptId for a Run's one Attempt, or undefined if none has started — recovery's only use of Attempt identity outside the projected AttemptState. */
  getAttemptId(runId: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM attempts WHERE run_id = ?').get(runId) as { id: string } | undefined;
    return row?.id;
  }

  private loadAttempt(runId: string): { record: AttemptRow | undefined; events: AttemptEvent[] } {
    const record = this.db.prepare('SELECT id, runtime, started_at FROM attempts WHERE run_id = ?')
      .get(runId) as AttemptRow | undefined;
    if (!record) return { record: undefined, events: [] };
    const events = (
      this.db.prepare('SELECT payload FROM attempt_events WHERE attempt_id = ? ORDER BY sequence ASC')
        .all(record.id) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as AttemptEvent);
    return { record, events };
  }

  /** Folds the durable event log into AttemptState and derives `status` from it (ticket 06 AC4) — see attempt-projection.ts for both reducers. Ticket 13: the Run's publication intent, if any, rides along the same way. */
  private attachAttempt(run: RawRun): WorkRun {
    const { record, events } = this.loadAttempt(run.id);
    const attempt = projectAttemptState(
      record ? { runtime: record.runtime as AgentType, startedAt: record.started_at } : undefined,
      events,
    );
    const pendingAttention = deriveOpenAttentionRequest(attempt);
    const status = deriveRunStatus(run.status as WorkRun['status'], attempt, pendingAttention);
    const publication = this.getRunPublication(run.id);
    return {
      ...run, status, attempt, pendingAttention, ...(publication ? { publication } : {}),
    };
  }

  // -- Run publications (ticket 13) --
  //
  // One durable intent per Run (run_id UNIQUE), written BEFORE any push or
  // pull-request command runs (AC3) and updated in place as execution
  // progresses — the only Run-scoped record that is ever updated rather
  // than appended, because its whole point is to be the single, current
  // answer to "did this external effect happen?".

  createRunPublication(publication: RunPublication): void {
    this.db.prepare(
      `INSERT INTO run_publications
         (id, run_id, idempotency_key, target, commit_sha, branch, state, authorized_by, authorized_at, updated_at,
          executions, result, reason)
       VALUES (@id, @runId, @idempotencyKey, @target, @commit, @branch, @state, @authorizedBy, @authorizedAt, @updatedAt,
          @executions, @result, @reason)`,
    ).run(this.publicationParams(publication));
  }

  /**
   * Ticket 13: updates every mutable field of an existing intent — not
   * only state/executions/result/reason. A retarget (DurableWorkEngine.
   * publish() re-authorizing a different target for the same Run) changes
   * `target`, `authorizedBy`, and `authorizedAt` too; leaving those columns
   * unwritten would silently keep reporting the original target forever
   * even though the in-memory object (and the actual push/pull-request it
   * drove) used the new one. `id`, `runId`, and `idempotencyKey` are the
   * one row's permanent identity and are never part of an update.
   */
  updateRunPublication(publication: RunPublication): void {
    this.db.prepare(
      `UPDATE run_publications SET target = @target, commit_sha = @commit, branch = @branch, state = @state,
         authorized_by = @authorizedBy, authorized_at = @authorizedAt, updated_at = @updatedAt,
         executions = @executions, result = @result, reason = @reason WHERE id = @id`,
    ).run(this.publicationParams(publication));
  }

  private publicationParams(publication: RunPublication): Record<string, unknown> {
    return {
      id: publication.id,
      runId: publication.runId,
      idempotencyKey: publication.idempotencyKey,
      target: publication.target,
      commit: publication.commit,
      branch: publication.branch,
      state: publication.state,
      authorizedBy: JSON.stringify(publication.authorizedBy),
      authorizedAt: publication.authorizedAt,
      updatedAt: publication.updatedAt,
      executions: publication.executions,
      result: toJson(publication.result),
      reason: publication.reason ?? null,
    };
  }

  getRunPublication(runId: string): RunPublication | undefined {
    const row = this.db.prepare('SELECT * FROM run_publications WHERE run_id = ?').get(runId) as RunPublicationTableRow | undefined;
    return row ? rowToRunPublication(row) : undefined;
  }

  /** Every intent a restart must reconcile before anything else can touch it (AC5): authorized but never executed, or executing when the previous process stopped. */
  listIncompleteRunPublications(): RunPublication[] {
    return (this.db.prepare("SELECT * FROM run_publications WHERE state IN ('authorized', 'executing') ORDER BY authorized_at")
      .all() as RunPublicationTableRow[]).map(rowToRunPublication);
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

  // -- repository verification policy (ticket 08) --
  //
  // Deliberately its own table, not a column on `repos`: that table is
  // rewritten wholesale by periodic filesystem discovery (git/scan.ts),
  // which knows nothing about verification and would otherwise silently
  // drop an admin's approved policy on the next scan.

  /** Sets (or replaces) the admin-approved verification policy for a Repository. */
  setRepositoryVerificationPolicy(repoId: string, policy: RepositoryVerificationPolicy): void {
    this.db.prepare(
      `INSERT INTO repo_verification_policy (repo_id, policy) VALUES (@repoId, @policy)
       ON CONFLICT(repo_id) DO UPDATE SET policy = excluded.policy`,
    ).run({ repoId, policy: JSON.stringify(policy) });
  }

  /** Undefined means no policy has ever been approved for this Repository — never conflated with an explicit no-verification declaration. */
  getRepositoryVerificationPolicy(repoId: string): RepositoryVerificationPolicy | undefined {
    const row = this.db.prepare('SELECT policy FROM repo_verification_policy WHERE repo_id = ?')
      .get(repoId) as { policy: string } | undefined;
    return row ? (JSON.parse(row.policy) as RepositoryVerificationPolicy) : undefined;
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

  // -- collaborators (ticket 11) --
  //
  // CollaboratorService (collaborators/service.ts) owns all hashing and
  // lifecycle logic; these methods are plain row storage, exactly the
  // CollaboratorStore surface it depends on. Bearer secrets never reach
  // here in plaintext -- only the hashes the service already computed.

  createCollaborator(row: CollaboratorRow): void {
    this.db.prepare(
      `INSERT INTO collaborators (id, display_name, created_at, granted_repository_ids, granted_profile_ids)
       VALUES (@id, @displayName, @createdAt, @grantedRepositoryIds, @grantedProfileIds)`,
    ).run({
      ...row,
      grantedRepositoryIds: JSON.stringify(row.grantedRepositoryIds),
      grantedProfileIds: JSON.stringify(row.grantedProfileIds),
    });
  }

  getCollaborator(id: string): CollaboratorRow | undefined {
    const row = this.db.prepare('SELECT * FROM collaborators WHERE id = ?').get(id) as CollaboratorTableRow | undefined;
    return row ? rowToCollaborator(row) : undefined;
  }

  listCollaborators(): CollaboratorRow[] {
    return (this.db.prepare('SELECT * FROM collaborators ORDER BY created_at').all() as CollaboratorTableRow[])
      .map(rowToCollaborator);
  }

  updateCollaboratorGrants(id: string, grants: { repositoryIds: string[]; profileIds: string[] }): void {
    this.db.prepare('UPDATE collaborators SET granted_repository_ids = ?, granted_profile_ids = ? WHERE id = ?')
      .run(JSON.stringify(grants.repositoryIds), JSON.stringify(grants.profileIds), id);
  }

  createInvitation(row: InvitationRow, codeHash: string): void {
    this.db.prepare(
      `INSERT INTO collaborator_invitations (id, collaborator_id, code_hash, created_at, expires_at)
       VALUES (@id, @collaboratorId, @codeHash, @createdAt, @expiresAt)`,
    ).run({ ...row, codeHash });
  }

  getInvitationByCodeHash(codeHash: string): InvitationRow | undefined {
    const row = this.db.prepare('SELECT * FROM collaborator_invitations WHERE code_hash = ?')
      .get(codeHash) as InvitationTableRow | undefined;
    return row ? rowToInvitation(row) : undefined;
  }

  consumeInvitation(id: string, consumedAt: string): void {
    this.db.prepare('UPDATE collaborator_invitations SET consumed_at = ? WHERE id = ?').run(consumedAt, id);
  }

  createDevice(row: DeviceRow, tokenHash: string): void {
    this.db.prepare(
      `INSERT INTO collaborator_devices (id, collaborator_id, device_label, token_hash, created_at)
       VALUES (@id, @collaboratorId, @deviceLabel, @tokenHash, @createdAt)`,
    ).run({ ...row, tokenHash });
  }

  getDeviceByTokenHash(tokenHash: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM collaborator_devices WHERE token_hash = ?')
      .get(tokenHash) as DeviceTableRow | undefined;
    return row ? rowToDevice(row) : undefined;
  }

  getDevice(id: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM collaborator_devices WHERE id = ?').get(id) as DeviceTableRow | undefined;
    return row ? rowToDevice(row) : undefined;
  }

  listDevices(collaboratorId?: string): DeviceRow[] {
    const rows = (collaboratorId === undefined
      ? this.db.prepare('SELECT * FROM collaborator_devices ORDER BY created_at').all()
      : this.db.prepare('SELECT * FROM collaborator_devices WHERE collaborator_id = ? ORDER BY created_at').all(collaboratorId)
    ) as DeviceTableRow[];
    return rows.map(rowToDevice);
  }

  revokeDevice(id: string, revokedAt: string): void {
    this.db.prepare('UPDATE collaborator_devices SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
  }

  /** Hard delete: children first to satisfy the `REFERENCES collaborators(id)` FK (foreign_keys pragma is ON), then the collaborator row itself. Leaves every other collaborator and all repository/profile/run data untouched. */
  removeCollaborator(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM collaborator_devices WHERE collaborator_id = ?').run(id);
      this.db.prepare('DELETE FROM collaborator_invitations WHERE collaborator_id = ?').run(id);
      this.db.prepare('DELETE FROM collaborators WHERE id = ?').run(id);
    })();
  }

  // -- profiles (ticket 12) --
  //
  // Immutable once created — no update method, only a new row — exactly
  // like a Run's own frozen work_spec.

  createProfile(profile: Profile): void {
    this.db.prepare(
      `INSERT INTO profiles (id, name, runtime_preference, budget, verification_intent, requested_delivery_result, created_at)
       VALUES (@id, @name, @runtimePreference, @budget, @verificationIntent, @requestedDeliveryResult, @createdAt)`,
    ).run({
      ...profile,
      runtimePreference: JSON.stringify(profile.runtimePreference),
      budget: JSON.stringify(profile.budget),
      verificationIntent: JSON.stringify(profile.verificationIntent),
    });
  }

  getProfile(id: string): Profile | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileTableRow | undefined;
    return row ? rowToProfile(row) : undefined;
  }

  listProfiles(): Profile[] {
    return (this.db.prepare('SELECT * FROM profiles ORDER BY created_at').all() as ProfileTableRow[]).map(rowToProfile);
  }

  // -- Run activity (ticket 12 AC2) --
  //
  // Append-only audit trail of who did what to a Run — never updated or
  // deleted, exactly like the events/attempt_events archives.

  appendRunActivity(activity: RunActivity): void {
    this.db.prepare(
      `INSERT INTO run_activity (id, run_id, kind, principal, device, at)
       VALUES (@id, @runId, @kind, @principal, @device, @at)`,
    ).run({
      id: activity.id, runId: activity.runId, kind: activity.kind, at: activity.at,
      principal: JSON.stringify(activity.principal),
      device: toJson(activity.device),
    });
  }

  listRunActivity(runId: string): RunActivity[] {
    return (this.db.prepare('SELECT * FROM run_activity WHERE run_id = ? ORDER BY at').all(runId) as RunActivityTableRow[])
      .map(rowToRunActivity);
  }
}

/** Open (and migrate) the store at the standard location for a config. */
export function openStore(dataDir: string): Store {
  return new Store(path.join(dataDir, 'agentdeck.db'));
}
