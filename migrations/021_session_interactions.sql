CREATE TABLE session_interactions (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,
  provider_session_id   TEXT NOT NULL,
  provider_request_id   TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  question              TEXT NOT NULL,
  choices               TEXT NOT NULL,
  context               TEXT,
  allows_free_text      INTEGER NOT NULL DEFAULT 0,
  requested_at          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  response              TEXT,
  response_delivered_at TEXT,
  responder_principal_id TEXT,
  responder_display_name TEXT,
  resolved_at           TEXT,
  UNIQUE(provider, provider_session_id, provider_request_id)
);

CREATE INDEX idx_session_interactions_session_requested
  ON session_interactions(session_id, requested_at);
