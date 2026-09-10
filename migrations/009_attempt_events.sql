-- Ticket 06: the durable Attempt event log. A Run's Attempt state (migration
-- 008) is no longer a single mutable JSON blob overwritten in place on every
-- update — it is rebuilt deterministically, on every read, by folding this
-- ordered, durably persisted, deduplicated event log (see
-- work-engine/attempt-projection.ts). `attempts` holds the one Attempt
-- metadata AgentDeck cannot derive from the event stream itself (which
-- runtime, when it started); `attempt_events` holds every durable
-- AttemptEvent, wrapped in its envelope metadata.
CREATE TABLE attempts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  runtime    TEXT NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX idx_attempts_run_id ON attempts(run_id);

CREATE TABLE attempt_events (
  attempt_id     TEXT NOT NULL REFERENCES attempts(id),
  sequence       INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  durability     TEXT NOT NULL,
  at             TEXT NOT NULL,
  payload        TEXT NOT NULL, -- JSON AttemptEvent (shared runtime-adapter shape only)
  PRIMARY KEY (attempt_id, sequence),
  -- The provider-deduplication guard: re-appending an event whose content
  -- (excluding its own sequence/timestamp) already exists for this Attempt
  -- is a no-op, so a redelivered provider notification after a reconnect
  -- never duplicates durable history.
  UNIQUE (attempt_id, dedupe_key)
);
