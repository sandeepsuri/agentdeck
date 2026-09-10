-- Ticket 03: a Run's isolated worktree preparation. Resolved base commit and
-- dedicated worktree are recorded before any runtime receives authority.
ALTER TABLE runs ADD COLUMN preparation TEXT NOT NULL DEFAULT '{"state":"pending"}';
