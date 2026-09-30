// Persistence for saved routines and their runs (migration 032). Exposed as
// Store.routines so the "no SQL outside src/store" rule holds. Deleting a
// routine only stamps it; its runs and the tasks they link to are kept.
import type { Database } from 'better-sqlite3';
import type { PersonalActor } from '../personal-tasks/types.js';
import type { Routine, RoutineBlockCode, RoutineConfig, RoutineRun, RoutineTaskSource } from '../personal-tasks/routines/types.js';

interface RoutineRow {
  id: string; name: string; config: string; source_task_id: string | null; created_at: string; created_by: string; updated_at: string; deleted_at: string | null;
}
interface RunRow {
  id: string; routine_id: string; sequence: number; at: string; by: string; config: string; outcome: string;
  task_source: string | null; task_id: string | null; block_code: string | null; reason: string | null;
}

function rowToRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    name: r.name,
    config: JSON.parse(r.config) as RoutineConfig,
    ...(r.source_task_id !== null ? { sourceTaskId: r.source_task_id } : {}),
    createdAt: r.created_at,
    createdBy: JSON.parse(r.created_by) as PersonalActor,
    updatedAt: r.updated_at,
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
  };
}

function rowToRun(r: RunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    sequence: r.sequence,
    at: r.at,
    by: JSON.parse(r.by) as PersonalActor,
    config: JSON.parse(r.config) as RoutineConfig,
    outcome: r.outcome as RoutineRun['outcome'],
    ...(r.task_source !== null && r.task_id !== null ? { task: { source: r.task_source as RoutineTaskSource, id: r.task_id } } : {}),
    ...(r.block_code !== null ? { block: { code: r.block_code as RoutineBlockCode, message: r.reason ?? '' } } : {}),
  };
}

export type NewRoutineRun = Omit<RoutineRun, 'id' | 'sequence'>;

export class RoutineRepository {
  constructor(private readonly db: Database) {}

  insert(routine: Routine): void {
    this.db.prepare(
      `INSERT INTO personal_routines (id, name, config, source_task_id, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(routine.id, routine.name, JSON.stringify(routine.config), routine.sourceTaskId ?? null, routine.createdAt,
      JSON.stringify(routine.createdBy), routine.updatedAt);
  }

  get(id: string): Routine | undefined {
    const row = this.db.prepare('SELECT * FROM personal_routines WHERE id = ?').get(id) as RoutineRow | undefined;
    return row && rowToRoutine(row);
  }

  /** Routines not deleted, newest first. */
  list(): Routine[] {
    return (this.db.prepare('SELECT * FROM personal_routines WHERE deleted_at IS NULL ORDER BY created_at DESC, id').all() as RoutineRow[]).map(rowToRoutine);
  }

  update(id: string, change: { name: string; config: RoutineConfig }, at: string): boolean {
    return this.db.prepare('UPDATE personal_routines SET name = ?, config = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(change.name, JSON.stringify(change.config), at, id).changes > 0;
  }

  markDeleted(id: string, at: string): boolean {
    return this.db.prepare('UPDATE personal_routines SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(at, at, id).changes > 0;
  }

  recordRun(run: NewRoutineRun & { id: string }): RoutineRun {
    return this.db.transaction(() => {
      const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM personal_routine_runs WHERE routine_id = ?')
        .get(run.routineId) as { n: number }).n;
      this.db.prepare(
        `INSERT INTO personal_routine_runs (id, routine_id, sequence, at, by, config, outcome, task_source, task_id, block_code, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(run.id, run.routineId, sequence, run.at, JSON.stringify(run.by), JSON.stringify(run.config), run.outcome,
        run.task?.source ?? null, run.task?.id ?? null, run.block?.code ?? null, run.block?.message ?? null);
      return { ...run, sequence };
    })();
  }

  /** Newest first. */
  listRuns(routineId: string): RoutineRun[] {
    return (this.db.prepare('SELECT * FROM personal_routine_runs WHERE routine_id = ? ORDER BY sequence DESC').all(routineId) as RunRow[]).map(rowToRun);
  }
}
