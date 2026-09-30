-- Saved routines (issue #92, Everyday 17). The owner saves a PDF or email
-- request that worked, and reruns it later. Each run is recorded here and,
-- when it starts, links to the new personal task or email task it created;
-- that task keeps its own attempts, result, and approvals. A routine holds no
-- approval and no credential: every move or send still needs the owner's
-- decision on that run's own proposal or draft.
--
-- Additive only: no existing table changes. Rollback: an older build ignores
-- these tables, so no downgrade step is required; tasks a routine started
-- remain in personal_tasks and email_tasks and stay readable. To remove the
-- data entirely, stop AgentDeck and run, in this order:
--   DROP TABLE personal_routine_runs; DROP TABLE personal_routines;
--   DELETE FROM schema_migrations WHERE name = '032_personal_routines.sql';
-- Deleting a routine is a timestamp, never a row delete, so its run history
-- and the tasks it links to survive.

CREATE TABLE personal_routines (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  config          TEXT NOT NULL,   -- JSON RoutineConfig: kind and the grant or account it uses
  source_task_id  TEXT,            -- the task the routine was saved from
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,   -- JSON PersonalActor
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE personal_routine_runs (
  id           TEXT PRIMARY KEY,
  routine_id   TEXT NOT NULL REFERENCES personal_routines(id),
  sequence     INTEGER NOT NULL,
  at           TEXT NOT NULL,
  by           TEXT NOT NULL,       -- JSON PersonalActor
  config       TEXT NOT NULL,       -- JSON RoutineConfig as it was for this run
  outcome      TEXT NOT NULL,       -- started | blocked
  task_source  TEXT,                -- personal | email, when started
  task_id      TEXT,                -- the task this run created, when started
  block_code   TEXT,                -- RoutineBlockCode, when blocked
  reason       TEXT,
  UNIQUE(routine_id, sequence)
);
