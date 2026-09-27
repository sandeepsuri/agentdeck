-- Approving and carrying out a filing proposal (issue #82, Everyday 07).
-- The approval and one receipt per planned file are written together BEFORE
-- anything moves, so a crash can never lose the fact that a move was
-- authorized. Each receipt is marked 'moving' immediately before its one
-- effect on disk and settled afterwards.
--
-- Additive only: no existing table changes. Rollback: an older build ignores
-- these tables, so no downgrade step is required; files already moved stay
-- where they were filed. To remove the data entirely, stop AgentDeck and run,
-- in this order:
--   DROP TABLE personal_filing_receipts; DROP TABLE personal_filing_approvals;
--   DELETE FROM schema_migrations WHERE name = '024_personal_filing_approvals.sql';
-- Forward repair (PersonalTaskService.recover, at boot):
--   - an approval that never started runs if it has not expired, or expires;
--   - a receipt left 'moving' is reconciled from the disk as moved, not moved,
--     or uncertain — never moved again;
--   - a receipt left 'pending' in a started execution is not attempted and is
--     reported as left in place.

-- One approval per proposal, ever (task_id UNIQUE): a repeated approve
-- returns this row instead of authorizing a second execution.
CREATE TABLE personal_filing_approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE REFERENCES personal_tasks(id),
  grant_id     TEXT NOT NULL REFERENCES folder_grants(id),
  plan_digest  TEXT NOT NULL,   -- the FilingProposalResult.planDigest the owner approved
  approved_by  TEXT NOT NULL,   -- JSON PersonalActor
  approved_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,   -- execution must start before this
  state        TEXT NOT NULL,   -- approved | executing | finished | expired
  started_at   TEXT,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_personal_filing_approvals_state ON personal_filing_approvals(state);

-- One durable receipt per plan entry, in plan order.
CREATE TABLE personal_filing_receipts (
  approval_id    TEXT NOT NULL REFERENCES personal_filing_approvals(id),
  sequence       INTEGER NOT NULL,
  source         TEXT NOT NULL,   -- grant-relative
  source_sha256  TEXT NOT NULL,
  target         TEXT NOT NULL,   -- grant-relative
  overwrite      INTEGER NOT NULL, -- 1 only when the owner approved replacing the target
  target_sha256  TEXT,            -- the content the owner agreed to replace
  state          TEXT NOT NULL,   -- pending | moving | moved | skipped | failed | uncertain
  reason         TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (approval_id, sequence)
);
