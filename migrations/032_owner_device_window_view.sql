-- Issue #91: an owner phone may view one Mac window the owner shared at the
-- Mac. Starting and stopping a view is recorded against the phone. SQLite
-- cannot widen a CHECK in place, so the audit table is rebuilt with every
-- existing row kept, as in 028. Nothing references this table.
--
-- No captured frame, window list, or shared-window choice is ever stored:
-- they live in memory only, so a service restart ends any view and forgets
-- the choice.
--
-- Rollback: an older build reads these rows but cannot write the new
-- actions; restore the data backup taken before the update.
CREATE TABLE owner_device_audit_032 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES owner_devices(id),
  action TEXT NOT NULL CHECK (action IN (
    'session-send', 'session-input',
    'personal-task-submit', 'personal-task-retry', 'filing-approve', 'filing-retry', 'filing-undo',
    'window-view-start', 'window-view-stop'
  )),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO owner_device_audit_032 (id, device_id, action, target_id, created_at)
  SELECT id, device_id, action, target_id, created_at FROM owner_device_audit;
DROP TABLE owner_device_audit;
ALTER TABLE owner_device_audit_032 RENAME TO owner_device_audit;
CREATE INDEX idx_owner_device_audit_device ON owner_device_audit(device_id, created_at);
