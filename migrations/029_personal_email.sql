-- Finding an email and preparing a reply (issue #88, Everyday 13). One table
-- of connected Gmail accounts, and email reply tasks with their attempts,
-- activity, and every version of the reply draft AgentDeck wrote to Gmail.
-- Nothing here sends mail, and no credential is stored: each account's
-- refresh token lives in the owner's login Keychain (service "AgentDeck
-- Gmail", account = email_account_grants.id).
--
-- Additive only: no existing table changes. Rollback: an older build ignores
-- these tables, so no downgrade step is required; drafts already in Gmail
-- stay there for the owner to send or delete in Gmail. To remove the data
-- entirely, stop AgentDeck and run, in this order:
--   DROP TABLE email_reply_drafts; DROP TABLE email_task_activity;
--   DROP TABLE email_task_attempts; DROP TABLE email_tasks; DROP TABLE email_account_grants;
--   DELETE FROM schema_migrations WHERE name = '029_personal_email.sql';
-- then delete the Keychain items: security delete-generic-password -s "AgentDeck Gmail" -a <id>
--
-- Account-grant migration: a Gmail account connected by the spike
-- (scripts/spikes/email) is not carried over; its token file is spike-only.
-- Connect the account again from Personal tasks. A later AgentDeck-owned
-- OAuth client (decision 0002) needs the same one reconnect: the refresh
-- token belongs to the client that obtained it, and a signed-out account
-- shows that repair state.
--
-- Forward repair (EmailTaskService.recover, at boot):
--   - an attempt left running is ended as interrupted, with no result, and
--     the task waits for the owner to try again (no provider turn is spent
--     on its own);
--   - a draft version left 'writing' or 'uncertain' is settled from what Gmail
--     holds: found by its X-AgentDeck-Intent header, it is recorded; proven
--     absent after the in-flight grace, it is marked not written. A second
--     provider draft is never created for the same version.

CREATE TABLE email_account_grants (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,   -- 'gmail'
  address       TEXT NOT NULL,   -- the mailbox address Google reported at consent
  scopes        TEXT NOT NULL,   -- JSON array of granted OAuth scopes
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,   -- JSON PersonalActor
  revoked_at    TEXT,
  state         TEXT NOT NULL,   -- EmailAccountState from the last check
  state_detail  TEXT,
  checked_at    TEXT
);

CREATE TABLE email_tasks (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES email_account_grants(id),
  workspace       TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  request         TEXT NOT NULL,   -- the owner's own words
  submitted_at    TEXT NOT NULL,
  submitted_by    TEXT NOT NULL,   -- JSON PersonalActor
  status          TEXT NOT NULL,   -- queued | running | completed | failed
  updated_at      TEXT NOT NULL,
  failure         TEXT,
  result          TEXT,            -- JSON EmailFindResult; set only by a completed attempt
  confirmed       TEXT,            -- JSON EmailMessageContext the owner confirmed
  confirmed_at    TEXT,
  confirmed_by    TEXT             -- JSON PersonalActor
);

CREATE INDEX idx_email_tasks_submitted ON email_tasks(submitted_at);

CREATE TABLE email_task_attempts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES email_tasks(id),
  sequence    INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,
  UNIQUE(task_id, sequence)
);

CREATE TABLE email_task_activity (
  task_id     TEXT NOT NULL REFERENCES email_tasks(id),
  sequence    INTEGER NOT NULL,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  attempt_id  TEXT,
  PRIMARY KEY (task_id, sequence)
);

-- One row per draft version. 'writing' is inserted before the one provider
-- write, so a crash or lost response is settled from Gmail rather than
-- written again.
CREATE TABLE email_reply_drafts (
  task_id            TEXT NOT NULL REFERENCES email_tasks(id),
  version            INTEGER NOT NULL,
  state              TEXT NOT NULL,   -- writing | saved | failed | uncertain
  origin             TEXT NOT NULL,   -- agentdeck | gmail
  content            TEXT NOT NULL,   -- JSON ReplyDraftContent
  digest             TEXT,            -- SHA-256 of the saved content
  provider_draft_id  TEXT,
  intent_id          TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,   -- JSON PersonalActor
  updated_at         TEXT NOT NULL,
  reason             TEXT,
  PRIMARY KEY (task_id, version)
);

-- At most one unsettled write per task, so two taps or two devices can never
-- create two provider drafts for one reply.
CREATE UNIQUE INDEX idx_email_reply_drafts_one_write ON email_reply_drafts(task_id) WHERE state IN ('writing', 'uncertain');
