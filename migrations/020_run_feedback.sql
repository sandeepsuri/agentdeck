-- Durable Task/Run feedback (docs/specs/run-feedback-review.md, B07): plain
-- free-text commentary, independent of session_chat_messages (migration
-- 019) -- a Run has no reliable attachable Session (see B13's own finding),
-- and feedback must remain readable for a completed/failed/cancelled Run
-- with no live process at all.
--
-- Keyed by task_id, not run_id: a Task's conversation should stay
-- addressable across a future retried Attempt/Run under the same Task
-- (B12 territory), rather than fragmenting per Run. `run_id` is kept
-- alongside for the one Run this entry was actually posted against.
--
-- Append-only in this slice: no UPDATE/DELETE path exists yet.
-- `deleted_at`/`review_decision` are reserved, unused columns for the
-- later-slice moderation (still B07) and review (B09) work the design
-- doc describes -- present now so a future slice is additive-only, never a
-- second migration touching this same table's shape.
CREATE TABLE run_feedback (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  posted_at       TEXT NOT NULL,
  principal_id    TEXT,          -- NULL for the legacy shared-token path
  display_name    TEXT NOT NULL,
  text            TEXT NOT NULL,
  deleted_at      TEXT,          -- reserved; unused in this slice
  review_decision TEXT           -- reserved; unused in this slice (B09)
);

CREATE INDEX idx_run_feedback_task_sequence ON run_feedback(task_id, sequence);
