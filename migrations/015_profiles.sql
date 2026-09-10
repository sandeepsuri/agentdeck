-- Ticket 12: CONTEXT.md's "Profile" -- a reusable, admin-approved
-- configuration for how work may run. Immutable once created (frozen the
-- same way a Run's own WorkSpec is): there is no update, only a new
-- Profile. A collaborator submitting a Run must name one they are granted
-- (collaborators.granted_profile_ids); the Work Engine derives the Run's
-- runtime/budget/verification/delivery fields from the frozen Profile
-- itself rather than trusting the submitter's own values for them.

CREATE TABLE profiles (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  runtime_preference    TEXT NOT NULL, -- JSON AgentType[]
  budget                TEXT NOT NULL, -- JSON RunBudget
  verification_intent   TEXT NOT NULL, -- JSON VerificationIntent
  requested_delivery_result TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
