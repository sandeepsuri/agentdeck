-- Ticket 12 AC1: a collaborator may launch a Run only against a Profile
-- they've been explicitly granted, mirroring granted_repository_ids
-- (014_collaborators.sql) exactly.
ALTER TABLE collaborators ADD COLUMN granted_profile_ids TEXT NOT NULL DEFAULT '[]';
