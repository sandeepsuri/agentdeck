-- Reaching the Mac away from home (issue #90, Everyday 15). Each owner phone
-- gains the public half of its channel key, which the Mac checks on every
-- relay connection, and the APNs token the relay pushes a content-free
-- "something needs you" pointer to. The phone keeps the private half in its
-- own Keychain; the Mac's keys live in the Mac's login Keychain (service
-- "AgentDeck Relay"). No task data moves: the Mac stays authoritative.
--
-- Additive only. A phone paired before this migration has no public key and
-- keeps working on the local network; the next time it reaches the Mac
-- directly it enrolls its key (POST /api/owner-pairing/relay-key) and can use
-- the relay from then on. Nothing needs re-pairing.
--
-- Rollback: an older build ignores these columns, so no downgrade step is
-- required. To remove them entirely, stop AgentDeck and run, in this order:
--   DROP INDEX idx_owner_devices_public_key;
--   ALTER TABLE owner_devices DROP COLUMN push_environment;
--   ALTER TABLE owner_devices DROP COLUMN push_token;
--   ALTER TABLE owner_devices DROP COLUMN public_key;
--   DELETE FROM schema_migrations WHERE name = '031_owner_device_relay.sql';
-- then delete the Mac's keys: security delete-generic-password -s "AgentDeck Relay" -a identity
--
-- Recovery:
--   - lost phone: revoke it on the Mac. Its credential stops resolving and
--     its key no longer matches an active device, so the relay path refuses
--     it at the next frame; the Mac also drops its open relay connections.
--   - key rotation (phone): re-enroll over a direct connection, or re-pair.
--     Rotation of the Mac's own keys: remove the Keychain item and re-pair
--     every phone (the old mailbox and key are then unknown to phones).
ALTER TABLE owner_devices ADD COLUMN public_key TEXT;
ALTER TABLE owner_devices ADD COLUMN push_token TEXT;
ALTER TABLE owner_devices ADD COLUMN push_environment TEXT;
CREATE UNIQUE INDEX idx_owner_devices_public_key ON owner_devices(public_key) WHERE public_key IS NOT NULL;
