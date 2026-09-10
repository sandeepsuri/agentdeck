-- Ticket 12 AC2: the initiating Principal and device recorded on every
-- Run-affecting action -- submission, input, approval, denial, pause,
-- resume, and cancellation -- append-only, exactly like the events/
-- attempt_events archives. `device` is NULL for the local admin (no
-- device concept, same as work_spec's principal column before this
-- ticket); a named collaborator's action always names one.
CREATE TABLE run_activity (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL, -- submitted | input | approved | denied | paused | resumed | cancelled
  principal  TEXT NOT NULL, -- JSON RunPrincipal
  device     TEXT,          -- JSON {id, label} or NULL
  at         TEXT NOT NULL
);

CREATE INDEX idx_run_activity_run_at ON run_activity(run_id, at);
