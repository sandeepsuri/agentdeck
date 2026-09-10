-- Ticket 10 AC2: who requested this Run (CONTEXT.md's "Principal") — frozen
-- at submit(), exactly like work_spec, and never updated afterward. Recorded
-- so a Run's own delivery commit can say who asked for it in its metadata.
ALTER TABLE runs ADD COLUMN principal TEXT NOT NULL DEFAULT '{"id":"unknown","displayName":"unknown"}';
