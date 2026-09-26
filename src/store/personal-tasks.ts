// Persistence for personal tasks and folder grants (migration 023). Exposed as
// Store.personal so the "no SQL outside src/store" rule holds here too.
// Status, result, and the attempt that produced them change in one
// transaction, so a crash can never leave a result without a completed
// attempt behind it.
import type { Database } from 'better-sqlite3';
import type {
  FolderGrant, PdfInventoryResult, PersonalActivityKind, PersonalActor, PersonalAttemptOutcome, PersonalTask,
  PersonalTaskActivity, PersonalTaskAttempt, PersonalTaskKind, PersonalTaskStatus,
} from '../personal-tasks/types.js';

interface GrantRow { id: string; root_path: string; created_at: string; created_by: string; revoked_at: string | null }
interface TaskRow {
  id: string; kind: string; workspace: string; grant_id: string; policy_version: string; files: string;
  submitted_at: string; submitted_by: string; status: string; updated_at: string; failure: string | null; result: string | null;
}
interface AttemptRow { id: string; sequence: number; started_at: string; ended_at: string | null; outcome: string | null }
interface ActivityRow { sequence: number; at: string; kind: string; message: string; attempt_id: string | null; path: string | null }

export type NewPersonalActivity = Omit<PersonalTaskActivity, 'sequence'>;

function rowToGrant(r: GrantRow): FolderGrant {
  return {
    id: r.id,
    rootPath: r.root_path,
    createdAt: r.created_at,
    createdBy: JSON.parse(r.created_by) as PersonalActor,
    ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
  };
}

function rowToTask(r: TaskRow): PersonalTask {
  return {
    id: r.id,
    kind: r.kind as PersonalTaskKind,
    workspace: r.workspace,
    grantId: r.grant_id,
    policyVersion: r.policy_version,
    files: JSON.parse(r.files) as string[],
    submittedAt: r.submitted_at,
    submittedBy: JSON.parse(r.submitted_by) as PersonalActor,
    status: r.status as PersonalTaskStatus,
    updatedAt: r.updated_at,
    ...(r.failure !== null ? { failure: r.failure } : {}),
    ...(r.result !== null ? { result: JSON.parse(r.result) as PdfInventoryResult } : {}),
  };
}

function rowToAttempt(r: AttemptRow): PersonalTaskAttempt {
  return {
    id: r.id,
    sequence: r.sequence,
    startedAt: r.started_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
    ...(r.outcome !== null ? { outcome: r.outcome as PersonalAttemptOutcome } : {}),
  };
}

function rowToActivity(r: ActivityRow): PersonalTaskActivity {
  return {
    sequence: r.sequence,
    at: r.at,
    kind: r.kind as PersonalActivityKind,
    message: r.message,
    ...(r.attempt_id !== null ? { attemptId: r.attempt_id } : {}),
    ...(r.path !== null ? { path: r.path } : {}),
  };
}

export class PersonalTaskRepository {
  constructor(private readonly db: Database) {}

  // -- grants --

  insertGrant(grant: FolderGrant): void {
    this.db.prepare(
      'INSERT INTO folder_grants (id, root_path, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, NULL)',
    ).run(grant.id, grant.rootPath, grant.createdAt, JSON.stringify(grant.createdBy));
  }

  getGrant(id: string): FolderGrant | undefined {
    const row = this.db.prepare('SELECT * FROM folder_grants WHERE id = ?').get(id) as GrantRow | undefined;
    return row && rowToGrant(row);
  }

  listGrants(): FolderGrant[] {
    return (this.db.prepare('SELECT * FROM folder_grants ORDER BY created_at DESC, id').all() as GrantRow[]).map(rowToGrant);
  }

  /** Returns false when the grant does not exist or was already revoked. */
  revokeGrant(id: string, at: string): boolean {
    return this.db.prepare('UPDATE folder_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes > 0;
  }

  // -- tasks --

  createTask(task: PersonalTask, activity: NewPersonalActivity): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO personal_tasks (id, kind, workspace, grant_id, policy_version, files, submitted_at, submitted_by, status, updated_at, failure, result)
         VALUES (@id, @kind, @workspace, @grantId, @policyVersion, @files, @submittedAt, @submittedBy, @status, @updatedAt, NULL, NULL)`,
      ).run({
        id: task.id, kind: task.kind, workspace: task.workspace, grantId: task.grantId, policyVersion: task.policyVersion,
        files: JSON.stringify(task.files), submittedAt: task.submittedAt, submittedBy: JSON.stringify(task.submittedBy),
        status: task.status, updatedAt: task.updatedAt,
      });
      this.insertActivity(task.id, activity);
    })();
  }

  getTask(id: string): PersonalTask | undefined {
    const row = this.db.prepare('SELECT * FROM personal_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row && rowToTask(row);
  }

  listTasks(): PersonalTask[] {
    return (this.db.prepare('SELECT * FROM personal_tasks ORDER BY submitted_at DESC, id').all() as TaskRow[]).map(rowToTask);
  }

  /** Tasks with no finished latest attempt: still queued, or running when the process stopped. */
  listUnsettledTasks(): PersonalTask[] {
    return (this.db.prepare(
      "SELECT * FROM personal_tasks WHERE status IN ('queued', 'running') ORDER BY submitted_at, id",
    ).all() as TaskRow[]).map(rowToTask);
  }

  listAttempts(taskId: string): PersonalTaskAttempt[] {
    return (this.db.prepare('SELECT * FROM personal_task_attempts WHERE task_id = ? ORDER BY sequence').all(taskId) as AttemptRow[])
      .map(rowToAttempt);
  }

  listActivity(taskId: string): PersonalTaskActivity[] {
    return (this.db.prepare('SELECT * FROM personal_task_activity WHERE task_id = ? ORDER BY sequence').all(taskId) as ActivityRow[])
      .map(rowToActivity);
  }

  appendActivity(taskId: string, activity: NewPersonalActivity): void {
    this.insertActivity(taskId, activity);
  }

  startAttempt(taskId: string, attemptId: string, at: string, activity: NewPersonalActivity): PersonalTaskAttempt {
    return this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM personal_task_attempts WHERE task_id = ?')
        .get(taskId) as { n: number }).n;
      this.db.prepare('INSERT INTO personal_task_attempts (id, task_id, sequence, started_at) VALUES (?, ?, ?, ?)')
        .run(attemptId, taskId, next, at);
      this.db.prepare("UPDATE personal_tasks SET status = 'running', failure = NULL, updated_at = ? WHERE id = ?").run(at, taskId);
      this.insertActivity(taskId, { ...activity, attemptId });
      return { id: attemptId, sequence: next, startedAt: at };
    })();
  }

  /**
   * Ends an attempt and settles the task in one transaction. A result is
   * written only for a completed attempt; an interrupted attempt returns the
   * task to 'queued' so recovery re-runs it rather than claiming an outcome.
   */
  finishAttempt(
    taskId: string,
    attemptId: string,
    at: string,
    outcome: PersonalAttemptOutcome,
    settle: { failure?: string; result?: PdfInventoryResult },
    activity: NewPersonalActivity,
  ): void {
    const status: PersonalTaskStatus = outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'queued';
    this.db.transaction(() => {
      this.db.prepare('UPDATE personal_task_attempts SET ended_at = ?, outcome = ? WHERE id = ? AND task_id = ? AND ended_at IS NULL')
        .run(at, outcome, attemptId, taskId);
      this.db.prepare('UPDATE personal_tasks SET status = ?, failure = ?, result = ?, updated_at = ? WHERE id = ?').run(
        status,
        settle.failure ?? null,
        outcome === 'completed' && settle.result ? JSON.stringify(settle.result) : null,
        at,
        taskId,
      );
      this.insertActivity(taskId, { ...activity, attemptId });
    })();
  }

  /** Marks a failed task queued again ahead of a retry attempt. Returns false unless it was failed. */
  requeueFailed(taskId: string, at: string, activity: NewPersonalActivity): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        "UPDATE personal_tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'failed'",
      ).run(at, taskId).changes > 0;
      if (changed) this.insertActivity(taskId, activity);
      return changed;
    })();
  }

  private insertActivity(taskId: string, activity: NewPersonalActivity): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM personal_task_activity WHERE task_id = ?')
      .get(taskId) as { n: number }).n;
    this.db.prepare(
      'INSERT INTO personal_task_activity (task_id, sequence, at, kind, message, attempt_id, path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(taskId, next, activity.at, activity.kind, activity.message, activity.attemptId ?? null, activity.path ?? null);
  }
}
