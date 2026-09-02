-- Ticket 11: named collaborators and their individually revocable device
-- credentials (CONTEXT.md's Principal, extended to remote human
-- collaborators distinct from the single local bootstrap admin).
--
-- Bearer secrets (invitation codes, device tokens) are never stored in
-- plaintext -- only their SHA-256 hashes, looked up by exact match. Losing
-- this database reveals no bearer value that was ever issued.

CREATE TABLE collaborators (
  id                       TEXT PRIMARY KEY,
  display_name             TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  granted_repository_ids   TEXT NOT NULL -- JSON string[]
);

CREATE TABLE collaborator_invitations (
  id              TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  code_hash       TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT
);

CREATE TABLE collaborator_devices (
  id              TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  device_label    TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE INDEX idx_collaborator_devices_collaborator ON collaborator_devices(collaborator_id);
CREATE INDEX idx_collaborator_invitations_collaborator ON collaborator_invitations(collaborator_id);
