-- An ended managed session is kept (not deleted) so it survives a server
-- restart (ticket 04). ended_at records when its process exited.
ALTER TABLE sessions ADD COLUMN ended_at TEXT;
