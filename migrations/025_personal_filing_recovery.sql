-- Issue #83: durable retry/undo requests and identity of the file selected
-- for a move. Additive migration; older builds ignore these columns/table.
-- Forward repair: PersonalTaskService.recover reconciles a receipt left
-- moving or undoing before continuing an unfinished operation. If rolling
-- back the application, leave this data in place and do not re-approve a plan.
ALTER TABLE personal_filing_receipts ADD COLUMN moved_dev INTEGER;
ALTER TABLE personal_filing_receipts ADD COLUMN moved_ino INTEGER;
ALTER TABLE personal_filing_receipts ADD COLUMN replaced INTEGER;
ALTER TABLE personal_filing_receipts ADD COLUMN undo_state TEXT;
ALTER TABLE personal_filing_receipts ADD COLUMN undo_reason TEXT;

CREATE TABLE personal_filing_operations (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES personal_filing_approvals(id),
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  sequences TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (approval_id, idempotency_key)
);
CREATE INDEX idx_personal_filing_operations_state ON personal_filing_operations(state);
