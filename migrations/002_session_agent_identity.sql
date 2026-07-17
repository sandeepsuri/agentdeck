ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_id
  ON sessions(agent_session_id);
