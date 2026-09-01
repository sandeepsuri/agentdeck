-- Ticket 06: `runs.attempt` (migration 008) is superseded by the
-- attempts/attempt_events tables (migration 009), which are now the sole
-- source of truth an Attempt's state is projected from. Keeping the old
-- column around would let it silently drift from that source of truth, so
-- it is dropped rather than left unused.
ALTER TABLE runs DROP COLUMN attempt;
