-- Owner phones are separate from collaborator devices and the legacy tailnet token.
-- Only hashes of high-entropy bearer credentials are durable.
CREATE TABLE owner_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE owner_device_audit (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES owner_devices(id),
  action TEXT NOT NULL CHECK (action IN ('session-send', 'session-input')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_owner_device_audit_device ON owner_device_audit(device_id, created_at);
