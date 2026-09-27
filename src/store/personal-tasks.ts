// Persistence for personal tasks and folder grants (migration 023). Exposed as
// Store.personal so the "no SQL outside src/store" rule holds here too.
// Status, result, and the attempt that produced them change in one
// transaction, so a crash can never leave a result without a completed
// attempt behind it.
import type { Database } from 'better-sqlite3';
import type {
  FilingApproval, FilingApprovalState, FilingReceipt, FilingReceiptState, FolderGrant, PersonalActivityKind, PersonalActor, PersonalAttemptOutcome, PersonalTask,
  PersonalTaskActivity, PersonalTaskAttempt, PersonalTaskKind, PersonalTaskResult, PersonalTaskStatus,
} from '../personal-tasks/types.js';

interface GrantRow { id: string; root_path: string; created_at: string; created_by: string; revoked_at: string | null }
interface TaskRow {
  id: string; kind: string; workspace: string; grant_id: string; policy_version: string; files: string;
  submitted_at: string; submitted_by: string; status: string; updated_at: string; failure: string | null; result: string | null;
}
interface AttemptRow { id: string; sequence: number; started_at: string; ended_at: string | null; outcome: string | null }
interface ActivityRow { sequence: number; at: string; kind: string; message: string; attempt_id: string | null; path: string | null }

interface ApprovalRow {
  id: string; task_id: string; grant_id: string; plan_digest: string; approved_by: string; approved_at: string; expires_at: string;
  state: string; started_at: string | null; finished_at: string | null; updated_at: string;
}
interface ReceiptRow {
  sequence: number; source: string; source_sha256: string; target: string; overwrite: number; target_sha256: string | null;
  state: string; reason: string | null; updated_at: string;
}

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
    ...(r.result !== null ? { result: JSON.parse(r.result) as PersonalTaskResult } : {}),
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

function rowToReceipt(r: ReceiptRow): FilingReceipt {
  return {
    sequence: r.sequence,
    source: r.source,
    sourceSha256: r.source_sha256,
    target: r.target,
    overwrite: r.overwrite === 1,
    ...(r.target_sha256 !== null ? { targetSha256: r.target_sha256 } : {}),
    state: r.state as FilingReceiptState,
    ...(r.reason !== null ? { reason: r.reason } : {}),
    updatedAt: r.updated_at,
  };
}

export type NewFilingApproval = Omit<FilingApproval, 'receipts' | 'startedAt' | 'finishedAt' | 'updatedAt'> & {
  receipts: readonly Omit<FilingReceipt, 'updatedAt'>[];
};

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
   * task to 'queued' so recovery re-runs it rather than claiming an outcome,
   * unless `requeue: false` asks for it to wait for the owner as failed.
   */
  finishAttempt(
    taskId: string,
    attemptId: string,
    at: string,
    outcome: PersonalAttemptOutcome,
    settle: { failure?: string; result?: PersonalTaskResult; requeue?: boolean },
    activity: NewPersonalActivity,
  ): void {
    const requeue = outcome === 'interrupted' && settle.requeue !== false;
    const status: PersonalTaskStatus = outcome === 'completed' ? 'completed' : requeue ? 'queued' : 'failed';
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

  // -- filing approvals (issue #82) --

  /**
   * Records the approval and every receipt, with its activity, in one
   * transaction, before anything moves. Returns false, writing nothing, when
   * the task already has an approval: a proposal is approved at most once.
   */
  createFilingApproval(approval: NewFilingApproval, activity: NewPersonalActivity): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM personal_filing_approvals WHERE task_id = ?').get(approval.taskId)) return false;
      this.db.prepare(
        `INSERT INTO personal_filing_approvals (id, task_id, grant_id, plan_digest, approved_by, approved_at, expires_at, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(approval.id, approval.taskId, approval.grantId, approval.planDigest, JSON.stringify(approval.approvedBy),
        approval.approvedAt, approval.expiresAt, approval.state, approval.approvedAt);
      const insert = this.db.prepare(
        `INSERT INTO personal_filing_receipts (approval_id, sequence, source, source_sha256, target, overwrite, target_sha256, state, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const receipt of approval.receipts) {
        insert.run(approval.id, receipt.sequence, receipt.source, receipt.sourceSha256, receipt.target, receipt.overwrite ? 1 : 0,
          receipt.targetSha256 ?? null, receipt.state, receipt.reason ?? null, approval.approvedAt);
      }
      this.insertActivity(approval.taskId, activity);
      return true;
    })();
  }

  getFilingApproval(taskId: string): FilingApproval | undefined {
    const row = this.db.prepare('SELECT * FROM personal_filing_approvals WHERE task_id = ?').get(taskId) as ApprovalRow | undefined;
    return row && this.rowToApproval(row);
  }

  /** Approvals whose execution has not finished: not yet started, or under way when the process stopped. */
  listUnsettledFilingApprovals(): FilingApproval[] {
    return (this.db.prepare(
      "SELECT * FROM personal_filing_approvals WHERE state IN ('approved', 'executing') ORDER BY approved_at, id",
    ).all() as ApprovalRow[]).map((row) => this.rowToApproval(row));
  }

  /** The single-execution guard: moves an approval from approved to executing. False if anything else already did. */
  startFilingExecution(approvalId: string, at: string): boolean {
    return this.db.prepare(
      "UPDATE personal_filing_approvals SET state = 'executing', started_at = ?, updated_at = ? WHERE id = ? AND state = 'approved'",
    ).run(at, at, approvalId).changes > 0;
  }

  /** Moves one receipt on only from the state the caller expects. False if it had already moved on. */
  settleFilingReceipt(
    approvalId: string, sequence: number, from: FilingReceiptState, to: FilingReceiptState, at: string, reason?: string,
  ): boolean {
    return this.db.prepare(
      'UPDATE personal_filing_receipts SET state = ?, reason = ?, updated_at = ? WHERE approval_id = ? AND sequence = ? AND state = ?',
    ).run(to, reason ?? null, at, approvalId, sequence, from).changes > 0;
  }

  /** Ends an approval as finished or expired; any receipt still pending is settled with `pendingReason`. */
  finishFilingApproval(
    approval: Pick<FilingApproval, 'id' | 'taskId'>, state: Extract<FilingApprovalState, 'finished' | 'expired'>, at: string,
    pendingReason: string, activity: NewPersonalActivity,
  ): void {
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE personal_filing_receipts SET state = 'failed', reason = ?, updated_at = ? WHERE approval_id = ? AND state = 'pending'",
      ).run(pendingReason, at, approval.id);
      this.db.prepare('UPDATE personal_filing_approvals SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?')
        .run(state, at, at, approval.id);
      this.insertActivity(approval.taskId, activity);
    })();
  }

  private rowToApproval(r: ApprovalRow): FilingApproval {
    const receipts = (this.db.prepare('SELECT * FROM personal_filing_receipts WHERE approval_id = ? ORDER BY sequence').all(r.id) as ReceiptRow[])
      .map(rowToReceipt);
    return {
      id: r.id,
      taskId: r.task_id,
      grantId: r.grant_id,
      planDigest: r.plan_digest,
      approvedBy: JSON.parse(r.approved_by) as PersonalActor,
      approvedAt: r.approved_at,
      expiresAt: r.expires_at,
      state: r.state as FilingApprovalState,
      ...(r.started_at !== null ? { startedAt: r.started_at } : {}),
      ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
      updatedAt: r.updated_at,
      receipts,
    };
  }

  private insertActivity(taskId: string, activity: NewPersonalActivity): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM personal_task_activity WHERE task_id = ?')
      .get(taskId) as { n: number }).n;
    this.db.prepare(
      'INSERT INTO personal_task_activity (task_id, sequence, at, kind, message, attempt_id, path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(taskId, next, activity.at, activity.kind, activity.message, activity.attemptId ?? null, activity.path ?? null);
  }
}
