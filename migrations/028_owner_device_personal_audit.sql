-- Issue #87: an owner phone may also submit personal tasks and decide filing
-- proposals. SQLite cannot widen a CHECK in place, so the audit table is
-- rebuilt with every existing row kept. Nothing references this table.
-- Rollback: an older build reads these rows but cannot write the new
-- actions; restore the data backup taken before the update.
CREATE TABLE owner_device_audit_028 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES owner_devices(id),
  action TEXT NOT NULL CHECK (action IN (
    'session-send', 'session-input',
    'personal-task-submit', 'personal-task-retry', 'filing-approve', 'filing-retry', 'filing-undo'
  )),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO owner_device_audit_028 (id, device_id, action, target_id, created_at)
  SELECT id, device_id, action, target_id, created_at FROM owner_device_audit;
DROP TABLE owner_device_audit;
ALTER TABLE owner_device_audit_028 RENAME TO owner_device_audit;
CREATE INDEX idx_owner_device_audit_device ON owner_device_audit(device_id, created_at);
