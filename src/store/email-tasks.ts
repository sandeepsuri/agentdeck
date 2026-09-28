// Persistence for connected email accounts, email reply tasks, and reply
// draft versions (migration 029). Exposed as Store.email so the "no SQL
// outside src/store" rule holds. A task's status, result, and the attempt
// that produced them change in one transaction, as for personal tasks.
import type { Database } from 'better-sqlite3';
import type {
  EmailAccountGrant, EmailAccountState, EmailFindResult, EmailMessageContext, EmailTask, ReplyDraftContent, ReplyDraftState, ReplyDraftVersion,
} from '../personal-tasks/email/types.js';
import type {
  PersonalActivityKind, PersonalActor, PersonalAttemptOutcome, PersonalTaskActivity, PersonalTaskAttempt, PersonalTaskStatus,
} from '../personal-tasks/types.js';

interface AccountRow {
  id: string; provider: string; address: string; scopes: string; created_at: string; created_by: string; revoked_at: string | null;
  state: string; state_detail: string | null; checked_at: string | null;
}
interface TaskRow {
  id: string; account_id: string; workspace: string; policy_version: string; request: string; submitted_at: string; submitted_by: string;
  status: string; updated_at: string; failure: string | null; result: string | null; confirmed: string | null; confirmed_at: string | null; confirmed_by: string | null;
}
interface AttemptRow { id: string; sequence: number; started_at: string; ended_at: string | null; outcome: string | null }
interface ActivityRow { sequence: number; at: string; kind: string; message: string; attempt_id: string | null }
interface DraftRow {
  task_id: string; version: number; state: string; origin: string; content: string; digest: string | null; provider_draft_id: string | null;
  intent_id: string; created_at: string; created_by: string; updated_at: string; reason: string | null;
}

export type NewEmailActivity = Omit<PersonalTaskActivity, 'sequence' | 'path'>;

function rowToAccount(r: AccountRow): EmailAccountGrant {
  return {
    id: r.id,
    provider: r.provider as EmailAccountGrant['provider'],
    address: r.address,
    scopes: JSON.parse(r.scopes) as string[],
    createdAt: r.created_at,
    createdBy: JSON.parse(r.created_by) as PersonalActor,
    ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
    state: r.state as EmailAccountState,
    ...(r.state_detail !== null ? { stateDetail: r.state_detail } : {}),
    ...(r.checked_at !== null ? { checkedAt: r.checked_at } : {}),
  };
}

function rowToTask(r: TaskRow): EmailTask {
  return {
    id: r.id,
    accountId: r.account_id,
    workspace: r.workspace,
    policyVersion: r.policy_version,
    request: r.request,
    submittedAt: r.submitted_at,
    submittedBy: JSON.parse(r.submitted_by) as PersonalActor,
    status: r.status as PersonalTaskStatus,
    updatedAt: r.updated_at,
    ...(r.failure !== null ? { failure: r.failure } : {}),
    ...(r.result !== null ? { result: JSON.parse(r.result) as EmailFindResult } : {}),
    ...(r.confirmed !== null ? { confirmed: JSON.parse(r.confirmed) as EmailMessageContext } : {}),
    ...(r.confirmed_at !== null ? { confirmedAt: r.confirmed_at } : {}),
    ...(r.confirmed_by !== null ? { confirmedBy: JSON.parse(r.confirmed_by) as PersonalActor } : {}),
  };
}

function rowToDraft(r: DraftRow): ReplyDraftVersion {
  return {
    version: r.version,
    state: r.state as ReplyDraftState,
    origin: r.origin as ReplyDraftVersion['origin'],
    content: JSON.parse(r.content) as ReplyDraftContent,
    ...(r.digest !== null ? { digest: r.digest } : {}),
    ...(r.provider_draft_id !== null ? { providerDraftId: r.provider_draft_id } : {}),
    intentId: r.intent_id,
    createdAt: r.created_at,
    createdBy: JSON.parse(r.created_by) as PersonalActor,
    updatedAt: r.updated_at,
    ...(r.reason !== null ? { reason: r.reason } : {}),
  };
}

export class EmailTaskRepository {
  constructor(private readonly db: Database) {}

  // -- accounts --

  insertAccount(account: EmailAccountGrant): void {
    this.db.prepare(
      `INSERT INTO email_account_grants (id, provider, address, scopes, created_at, created_by, revoked_at, state, state_detail, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(account.id, account.provider, account.address, JSON.stringify(account.scopes), account.createdAt, JSON.stringify(account.createdBy),
      account.state, account.stateDetail ?? null, account.checkedAt ?? null);
  }

  getAccount(id: string): EmailAccountGrant | undefined {
    const row = this.db.prepare('SELECT * FROM email_account_grants WHERE id = ?').get(id) as AccountRow | undefined;
    return row && rowToAccount(row);
  }

  listAccounts(): EmailAccountGrant[] {
    return (this.db.prepare('SELECT * FROM email_account_grants ORDER BY created_at DESC, id').all() as AccountRow[]).map(rowToAccount);
  }

  /** Returns false when the account does not exist or was already revoked. */
  revokeAccount(id: string, at: string): boolean {
    return this.db.prepare('UPDATE email_account_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes > 0;
  }

  setAccountState(id: string, state: EmailAccountState, detail: string | undefined, at: string): void {
    this.db.prepare('UPDATE email_account_grants SET state = ?, state_detail = ?, checked_at = ? WHERE id = ?').run(state, detail ?? null, at, id);
  }

  /** At boot: every check is re-done before it is trusted again. */
  markAccountsUnchecked(): void {
    this.db.prepare("UPDATE email_account_grants SET state = 'unchecked' WHERE revoked_at IS NULL AND state = 'ready'").run();
  }

  // -- tasks --

  createTask(task: EmailTask, activity: NewEmailActivity): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO email_tasks (id, account_id, workspace, policy_version, request, submitted_at, submitted_by, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.accountId, task.workspace, task.policyVersion, task.request, task.submittedAt, JSON.stringify(task.submittedBy), task.status, task.updatedAt);
      this.insertActivity(task.id, activity);
    })();
  }

  getTask(id: string): EmailTask | undefined {
    const row = this.db.prepare('SELECT * FROM email_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row && rowToTask(row);
  }

  listTasks(): EmailTask[] {
    return (this.db.prepare('SELECT * FROM email_tasks ORDER BY submitted_at DESC, id').all() as TaskRow[]).map(rowToTask);
  }

  listUnsettledTasks(): EmailTask[] {
    return (this.db.prepare("SELECT * FROM email_tasks WHERE status IN ('queued', 'running') ORDER BY submitted_at, id").all() as TaskRow[]).map(rowToTask);
  }

  listAttempts(taskId: string): PersonalTaskAttempt[] {
    return (this.db.prepare('SELECT * FROM email_task_attempts WHERE task_id = ? ORDER BY sequence').all(taskId) as AttemptRow[]).map((r) => ({
      id: r.id,
      sequence: r.sequence,
      startedAt: r.started_at,
      ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
      ...(r.outcome !== null ? { outcome: r.outcome as PersonalAttemptOutcome } : {}),
    }));
  }

  listActivity(taskId: string): PersonalTaskActivity[] {
    return (this.db.prepare('SELECT * FROM email_task_activity WHERE task_id = ? ORDER BY sequence').all(taskId) as ActivityRow[]).map((r) => ({
      sequence: r.sequence,
      at: r.at,
      kind: r.kind as PersonalActivityKind,
      message: r.message,
      ...(r.attempt_id !== null ? { attemptId: r.attempt_id } : {}),
    }));
  }

  appendActivity(taskId: string, activity: NewEmailActivity): void {
    this.insertActivity(taskId, activity);
  }

  startAttempt(taskId: string, attemptId: string, at: string, activity: NewEmailActivity): PersonalTaskAttempt {
    return this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM email_task_attempts WHERE task_id = ?').get(taskId) as { n: number }).n;
      this.db.prepare('INSERT INTO email_task_attempts (id, task_id, sequence, started_at) VALUES (?, ?, ?, ?)').run(attemptId, taskId, next, at);
      this.db.prepare("UPDATE email_tasks SET status = 'running', failure = NULL, updated_at = ? WHERE id = ?").run(at, taskId);
      this.insertActivity(taskId, { ...activity, attemptId });
      return { id: attemptId, sequence: next, startedAt: at };
    })();
  }

  /**
   * Ends an attempt and settles the task. A result is written only by a
   * completed attempt, and only while that attempt is still open, so an
   * attempt already ended as interrupted can never settle the task late.
   * Nothing here re-queues. Returns false when the attempt had already ended.
   */
  finishAttempt(
    taskId: string, attemptId: string, at: string, outcome: PersonalAttemptOutcome,
    settle: { failure?: string; result?: EmailFindResult }, activity: NewEmailActivity,
  ): boolean {
    const status: PersonalTaskStatus = outcome === 'completed' ? 'completed' : 'failed';
    return this.db.transaction(() => {
      const open = this.db.prepare('UPDATE email_task_attempts SET ended_at = ?, outcome = ? WHERE id = ? AND task_id = ? AND ended_at IS NULL')
        .run(at, outcome, attemptId, taskId).changes > 0;
      if (!open) return false;
      this.db.prepare('UPDATE email_tasks SET status = ?, failure = ?, result = ?, updated_at = ? WHERE id = ?').run(
        status, settle.failure ?? null, outcome === 'completed' && settle.result ? JSON.stringify(settle.result) : null, at, taskId,
      );
      this.insertActivity(taskId, { ...activity, attemptId });
      return true;
    })();
  }

  /** A failed task goes back to queued for a new attempt; false unless it was failed and nothing was confirmed. */
  requeueFailed(taskId: string, at: string, activity: NewEmailActivity): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        "UPDATE email_tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'failed' AND confirmed IS NULL",
      ).run(at, taskId).changes > 0;
      if (changed) this.insertActivity(taskId, activity);
      return changed;
    })();
  }

  /** Records the message the owner confirmed. False when the task was already confirmed. */
  confirmMessage(taskId: string, context: EmailMessageContext, actor: PersonalActor, at: string, activity: NewEmailActivity): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        "UPDATE email_tasks SET confirmed = ?, confirmed_at = ?, confirmed_by = ?, updated_at = ? WHERE id = ? AND confirmed IS NULL AND status = 'completed'",
      ).run(JSON.stringify(context), at, JSON.stringify(actor), at, taskId).changes > 0;
      if (changed) this.insertActivity(taskId, activity);
      return changed;
    })();
  }

  // -- reply drafts --

  /**
   * Records a new version as 'writing' before its provider write. Returns
   * undefined, writing nothing, when another write for the task is still
   * unsettled or the latest version is no longer `expectedLatest`.
   */
  beginDraftVersion(
    taskId: string, expectedLatest: number,
    draft: Pick<ReplyDraftVersion, 'origin' | 'content' | 'intentId' | 'createdAt' | 'createdBy'> & { providerDraftId?: string },
  ): number | undefined {
    return this.db.transaction(() => {
      const latest = (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM email_reply_drafts WHERE task_id = ?').get(taskId) as { n: number }).n;
      if (latest !== expectedLatest) return undefined;
      const open = this.db.prepare("SELECT 1 FROM email_reply_drafts WHERE task_id = ? AND state IN ('writing', 'uncertain')").get(taskId);
      if (open) return undefined;
      const version = latest + 1;
      this.db.prepare(
        `INSERT INTO email_reply_drafts (task_id, version, state, origin, content, digest, provider_draft_id, intent_id, created_at, created_by, updated_at, reason)
         VALUES (?, ?, 'writing', ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
      ).run(taskId, version, draft.origin, JSON.stringify(draft.content), draft.providerDraftId ?? null, draft.intentId, draft.createdAt,
        JSON.stringify(draft.createdBy), draft.createdAt);
      return version;
    })();
  }

  /** Records a version already saved in Gmail, such as a change the owner made there. */
  insertSavedDraftVersion(taskId: string, draft: Omit<ReplyDraftVersion, 'version' | 'state' | 'updatedAt'>, activity: NewEmailActivity): number {
    return this.db.transaction(() => {
      const version = (this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM email_reply_drafts WHERE task_id = ?').get(taskId) as { n: number }).n;
      this.db.prepare(
        `INSERT INTO email_reply_drafts (task_id, version, state, origin, content, digest, provider_draft_id, intent_id, created_at, created_by, updated_at, reason)
         VALUES (?, ?, 'saved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(taskId, version, draft.origin, JSON.stringify(draft.content), draft.digest ?? null, draft.providerDraftId ?? null, draft.intentId,
        draft.createdAt, JSON.stringify(draft.createdBy), draft.createdAt, draft.reason ?? null);
      this.insertActivity(taskId, activity);
      return version;
    })();
  }

  /** Moves a version on from an expected state; false when it had already moved. */
  settleDraftVersion(
    taskId: string, version: number, from: readonly ReplyDraftState[], to: ReplyDraftState, at: string,
    fields: { content?: ReplyDraftContent; digest?: string; providerDraftId?: string; reason?: string },
    activity?: NewEmailActivity,
  ): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE email_reply_drafts SET state = ?, updated_at = ?,
           content = COALESCE(?, content), digest = COALESCE(?, digest), provider_draft_id = COALESCE(?, provider_draft_id), reason = ?
         WHERE task_id = ? AND version = ? AND state IN (${from.map(() => '?').join(', ')})`,
      ).run(to, at, fields.content ? JSON.stringify(fields.content) : null, fields.digest ?? null, fields.providerDraftId ?? null, fields.reason ?? null,
        taskId, version, ...from).changes > 0;
      if (changed && activity) this.insertActivity(taskId, activity);
      return changed;
    })();
  }

  /** Newest first. */
  listDrafts(taskId: string): ReplyDraftVersion[] {
    return (this.db.prepare('SELECT * FROM email_reply_drafts WHERE task_id = ? ORDER BY version DESC').all(taskId) as DraftRow[]).map(rowToDraft);
  }

  listUnsettledDrafts(): Array<{ taskId: string; draft: ReplyDraftVersion }> {
    return (this.db.prepare("SELECT * FROM email_reply_drafts WHERE state IN ('writing', 'uncertain') ORDER BY task_id, version").all() as DraftRow[])
      .map((row) => ({ taskId: row.task_id, draft: rowToDraft(row) }));
  }

  private insertActivity(taskId: string, activity: NewEmailActivity): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM email_task_activity WHERE task_id = ?').get(taskId) as { n: number }).n;
    this.db.prepare('INSERT INTO email_task_activity (task_id, sequence, at, kind, message, attempt_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, next, activity.at, activity.kind, activity.message, activity.attemptId ?? null);
  }
}
