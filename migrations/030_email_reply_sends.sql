-- Approving and sending a reply exactly once (issue #89, Everyday 14). One row
-- per owner approval of one saved draft version. The row, with the exact
-- content it binds to and a fresh send intent, is written before the one
-- Gmail send; the send carries the intent in X-AgentDeck-Intent so an
-- uncertain outcome is settled from Gmail's Sent mail, never by sending again.
--
-- Additive only: no existing table changes. Rollback: an older build ignores
-- this table and has no send, so no downgrade step is required; mail already
-- sent stays in Gmail's Sent folder. To remove the data entirely, stop
-- AgentDeck and run:
--   DROP TABLE email_reply_sends;
--   DELETE FROM schema_migrations WHERE name = '030_email_reply_sends.sql';
--
-- Forward repair (EmailTaskService.recover, at boot):
--   - 'approved' that never started: sent if its approval is still in time,
--     else 'expired' (nothing was sent; the owner approves again);
--   - 'sending' (the process stopped around the send): becomes 'ambiguous';
--   - 'ambiguous': after the in-flight grace, Gmail's thread is read for a
--     sent message carrying the intent. Found: 'sent'. Proven absent:
--     'failed' (not sent). Gmail unreachable: stays 'ambiguous' and the owner
--     can check again. Operator recovery for a row that cannot be settled:
--     look in Gmail's Sent folder for the reply, then either leave it (the
--     owner checks again once Gmail answers) or, only when certain it was not
--     sent, UPDATE email_reply_sends SET state = 'failed' WHERE send_id = ?.

CREATE TABLE email_reply_sends (
  send_id            TEXT PRIMARY KEY,   -- also the X-AgentDeck-Intent of the sent message
  task_id            TEXT NOT NULL REFERENCES email_tasks(id),
  draft_version      INTEGER NOT NULL,
  digest             TEXT NOT NULL,      -- the saved version's digest the owner approved
  content            TEXT NOT NULL,      -- JSON ReplyDraftContent: exactly what is sent
  state              TEXT NOT NULL,      -- approved | sending | sent | failed | ambiguous | expired
  approved_at        TEXT NOT NULL,
  approved_by        TEXT NOT NULL,      -- JSON PersonalActor
  expires_at         TEXT NOT NULL,      -- the send must start before this
  started_at         TEXT,
  settled_at         TEXT,
  provider_message_id TEXT,
  reason             TEXT,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (task_id, draft_version) REFERENCES email_reply_drafts(task_id, version)
);

CREATE INDEX idx_email_reply_sends_task ON email_reply_sends(task_id, approved_at);

-- At most one live send per reply: a double tap, a second device, or a retry
-- can never start a second send while one is pending, uncertain, or done.
CREATE UNIQUE INDEX idx_email_reply_sends_one_live ON email_reply_sends(task_id) WHERE state IN ('approved', 'sending', 'sent', 'ambiguous');
