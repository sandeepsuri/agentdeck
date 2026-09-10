-- Ticket 05: the one Attempt a Run has started, tracked with its ordered
-- shared-shape event history. Starts idle; becomes running (accumulating
-- events), then completed or failed once the runtime adapter reports a
-- terminal event. No runtime-specific field (e.g. a provider conversation
-- id) is ever stored here — only the shared AttemptEvent shape.
ALTER TABLE runs ADD COLUMN attempt TEXT NOT NULL DEFAULT '{"state":"idle"}';
