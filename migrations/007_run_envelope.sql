-- Ticket 04: the admin-approved capability envelope frozen for a Run before
-- any runtime receives authority. Starts pending; becomes ready (with the
-- enforced Profile) or refused (with a human-readable reason) once the
-- worktree is prepared and runtime readiness is evaluated.
ALTER TABLE runs ADD COLUMN envelope TEXT NOT NULL DEFAULT '{"state":"pending"}';
