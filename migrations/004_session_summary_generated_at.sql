-- Wrap-up summaries live on the existing store (spec: "Considered and
-- rejected: SessionArchive" — a dedicated module would just be a
-- pass-through). The summary text itself is a file, sessions/<id>/summary.md
-- (see src/sessions/summary.ts), parallel to scrollback.txt; this column
-- only records whether/when one was generated, following the same small
-- metadata-in-SQLite pattern as ended_at (migrations/003_session_ended_at.sql).
ALTER TABLE sessions ADD COLUMN summary_generated_at TEXT;
