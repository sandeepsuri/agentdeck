-- Ticket 08: the admin-approved verification declaration for a Repository —
-- kept separate from the `repos` table (migration 001), which is rewritten
-- wholesale by periodic filesystem discovery (git/scan.ts) and must never
-- silently drop an admin's approved policy. Never read from anything inside
-- the Repository's own working tree, so a runtime with write access to a
-- Run's worktree cannot influence it.
CREATE TABLE IF NOT EXISTS repo_verification_policy (
  repo_id TEXT PRIMARY KEY,
  policy  TEXT NOT NULL  -- JSON RepositoryVerificationPolicy
);
