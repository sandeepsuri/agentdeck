-- Durable work intent is additive to the existing Session model. A Run is
-- deliberately independent from a Session or provider conversation.
ALTER TABLE tasks ADD COLUMN objective TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT; -- JSON string[]

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  status       TEXT NOT NULL,
  work_spec    TEXT NOT NULL, -- JSON WorkSpec, frozen at submission
  submitted_at TEXT NOT NULL
);

CREATE INDEX idx_runs_submitted_at ON runs(submitted_at DESC);
