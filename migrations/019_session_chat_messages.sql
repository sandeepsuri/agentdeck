-- Shared session chat (docs/specs/shared-session-chat.md): one durable,
-- attributed row per HUMAN post to a Session's conversation. The agent's own
-- turns are not duplicated here -- they still live in the per-repository
-- .agents/bus.jsonl and are merged in at read time (see
-- server/session-conversation.ts) -- this table exists so that a human
-- message finally carries who actually sent it, instead of being collapsed
-- into a `dashboard:<sessionId>` bus row with no Principal at all.
--
-- `audience` is the mention-routing decision made at post time ('chat' never
-- reaches the runtime; 'agent' does, or attempts to -- see `delivery`).
-- `sequence` is monotonic per session_id, assigned by the Store, so a
-- collaborator's reconnect-and-repoll can never duplicate or reorder a post.
CREATE TABLE session_chat_messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  author_kind     TEXT NOT NULL, -- always 'human' today; kept for a future ingested/legacy row
  principal_id    TEXT,          -- NULL for the legacy shared-token path
  display_name    TEXT NOT NULL,
  text            TEXT NOT NULL,
  audience        TEXT NOT NULL, -- 'chat' | 'agent'
  delivery        TEXT,          -- 'sent' | 'queued' | 'not_sent' -- NULL when audience = 'chat'
  delivery_reason TEXT
);

CREATE INDEX idx_session_chat_messages_session_sequence ON session_chat_messages(session_id, sequence);
