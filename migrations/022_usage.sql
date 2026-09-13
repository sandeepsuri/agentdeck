-- Local Claude Code / Codex token usage, indexed incrementally from the
-- logs both CLIs already write (see src/usage/indexer.ts).

-- One scan cursor per log file. Codex files also carry the running
-- session/model/total state so a resumed scan attributes appended
-- token_count lines correctly.
CREATE TABLE usage_files (
  path              TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  offset            INTEGER NOT NULL,
  codex_session_id  TEXT,
  codex_cwd         TEXT,
  codex_model       TEXT,
  codex_last_total  INTEGER
);

CREATE TABLE usage_events (
  provider              TEXT NOT NULL,
  event_key             TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  cwd                   TEXT,
  occurred_at           TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  speed                 TEXT,
  UNIQUE(provider, event_key)
);

CREATE INDEX idx_usage_events_occurred ON usage_events(occurred_at);
CREATE INDEX idx_usage_events_model ON usage_events(model, occurred_at);
CREATE INDEX idx_usage_events_session ON usage_events(provider, session_id);

-- Latest plan-limit snapshot per provider (only Codex reports one today).
CREATE TABLE usage_rate_limits (
  provider      TEXT PRIMARY KEY,
  plan_type     TEXT,
  primary_json  TEXT,
  secondary_json TEXT,
  observed_at   TEXT NOT NULL
);

CREATE TABLE model_news (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  url          TEXT,
  published_at TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE INDEX idx_model_news_published ON model_news(published_at);
