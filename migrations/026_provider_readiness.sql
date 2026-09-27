-- Issue #85 (Everyday 10): the last readiness check of each provider CLI set
-- up from the Mac app. Readiness metadata only: the state, a plain-language
-- detail, the CLI version, how it is signed in (e.g. 'claude.ai', 'chatgpt'),
-- and the plan name. No account email, organization, token, password, or API
-- key is ever stored — credentials stay in the provider's own storage
-- (Claude Code's Keychain item, Codex's ~/.codex).
--
-- Additive only. Rollback: an older build ignores this table, so no downgrade
-- step is required. To remove the data, stop AgentDeck and run
--   DROP TABLE provider_readiness;
--   DELETE FROM schema_migrations WHERE name = '026_provider_readiness.sql';
-- Forward repair: nothing to repair. A row is a cache of the last check and is
-- replaced by the next one; after a relaunch it is shown as unconfirmed until
-- the check runs again, so a sign-out or account change made outside
-- AgentDeck is always noticed.
CREATE TABLE provider_readiness (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  cli_version TEXT,
  auth_method TEXT,
  plan TEXT,
  checked_at TEXT NOT NULL,
  last_ready_at TEXT
);
