-- Personal tasks and folder grants (issue #80, Everyday 05). Owner work on
-- personal files, kept apart from Runs/Sessions: nothing here references
-- runs, tasks, or sessions, and no existing table changes.
--
-- Additive only. Rollback: an older build ignores these tables, so no
-- downgrade step is required. To remove the data entirely, stop AgentDeck and
-- run, in this order:
--   DROP TABLE personal_task_activity; DROP TABLE personal_task_attempts;
--   DROP TABLE personal_tasks; DROP TABLE folder_grants;
--   DELETE FROM schema_migrations WHERE name = '023_personal_tasks.sql';
-- Forward repair: a task left 'running' by a crash is ended as interrupted
-- and re-run as a new attempt at boot (PersonalTaskService.recover); no
-- result is ever written without a completed attempt.

-- One folder the owner picked. root_path is canonical (realpath) at grant
-- time and re-checked on every read. Revocation is a timestamp, never a
-- delete, so tasks keep pointing at the grant they ran under.
CREATE TABLE folder_grants (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,   -- JSON PersonalActor
  revoked_at  TEXT
);

CREATE TABLE personal_tasks (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  workspace       TEXT NOT NULL,
  grant_id        TEXT NOT NULL REFERENCES folder_grants(id),
  policy_version  TEXT NOT NULL,
  files           TEXT NOT NULL,   -- JSON array of grant-relative paths
  submitted_at    TEXT NOT NULL,
  submitted_by    TEXT NOT NULL,   -- JSON PersonalActor
  status          TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  failure         TEXT,
  result          TEXT             -- JSON PdfInventoryResult; set only by a completed attempt
);

CREATE INDEX idx_personal_tasks_submitted ON personal_tasks(submitted_at);

CREATE TABLE personal_task_attempts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES personal_tasks(id),
  sequence    INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,
  UNIQUE(task_id, sequence)
);

CREATE TABLE personal_task_activity (
  task_id     TEXT NOT NULL REFERENCES personal_tasks(id),
  sequence    INTEGER NOT NULL,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  attempt_id  TEXT,
  path        TEXT,
  PRIMARY KEY (task_id, sequence)
);
