-- Initial schema. Tables mirror src/types.ts; nested/array fields are JSON
-- text columns. External sessions are keyed `ext-${pid}-${startTime}` so
-- labels survive restarts (DESIGN §6).

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  origin           TEXT NOT NULL,
  agent            TEXT NOT NULL,
  name             TEXT,
  task_id          TEXT,
  repo_id          TEXT,
  cwd              TEXT NOT NULL,
  branch           TEXT,
  worktree_path    TEXT,
  pid              INTEGER,
  started_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  status           TEXT NOT NULL,
  status_source    TEXT NOT NULL,
  backend          TEXT,
  tmux_target      TEXT,
  launch_spec      TEXT,   -- JSON LaunchSpec
  tty              TEXT,
  terminal_app     TEXT,
  terminal_ref     TEXT    -- JSON {windowId, tabId, sessionId?}
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  repo_id     TEXT,
  status      TEXT NOT NULL,
  depends_on  TEXT,          -- JSON string[]
  session_ids TEXT NOT NULL  -- JSON string[]
);

CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  name           TEXT NOT NULL,
  current_branch TEXT,
  is_dirty       INTEGER,
  dirty_files    TEXT,  -- JSON string[]
  worktrees      TEXT   -- JSON {path, branch}[]
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- JSON
);

-- Archive of ingested bus lines (AgentMessage), append-only.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  agent   TEXT NOT NULL,
  repo    TEXT NOT NULL,
  event   TEXT NOT NULL,
  payload TEXT NOT NULL  -- full JSON AgentMessage
);

CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_id);
CREATE INDEX IF NOT EXISTS idx_events_repo_ts ON events(repo, ts);
