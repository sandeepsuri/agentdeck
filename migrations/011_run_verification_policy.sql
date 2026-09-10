-- Ticket 08: the Repository's admin-approved verification policy, resolved
-- and frozen onto a Run once preparation completes — never re-read from the
-- Repository's live policy afterward. Starts pending; becomes ready (with
-- the frozen required gates), declared-unverified, or missing (surfaced,
-- never silently treated as success) once the worktree is prepared.
ALTER TABLE runs ADD COLUMN verification_policy TEXT NOT NULL DEFAULT '{"state":"pending"}';
