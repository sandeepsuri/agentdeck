-- Ticket 13: the durable publication intent for a verified Run result —
-- persisted BEFORE any push or pull-request command runs (AC3), so a crash
-- mid-execution can never lose the fact that an external effect was
-- authorized and attempted. One intent per Run; idempotency_key is the
-- stable identity (run + exact commit) a repeated command resolves to.
CREATE TABLE run_publications (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL UNIQUE REFERENCES runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  target          TEXT NOT NULL, -- push | draft-pull-request
  commit_sha      TEXT NOT NULL,
  branch          TEXT NOT NULL,
  state           TEXT NOT NULL, -- authorized | executing | succeeded | failed | ambiguous
  authorized_by   TEXT NOT NULL, -- JSON RunPrincipal
  authorized_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  executions      INTEGER NOT NULL DEFAULT 0,
  result          TEXT,          -- JSON RunPublicationResult, only once succeeded
  reason          TEXT           -- explanation for failed | ambiguous
);

CREATE INDEX idx_run_publications_state ON run_publications(state);
