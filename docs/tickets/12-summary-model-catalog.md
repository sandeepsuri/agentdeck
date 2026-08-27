# 12: Choose the summary model from a fetched catalog

**What to build:** The model used for summaries becomes selectable: a default in settings, and an override at wrap-up time. The list of models is fetched from each provider at runtime rather than hardcoded, because model identifiers drift and a stale hardcoded list is worse than a fetch.

Providers bill differently and the picker must say so: one path rides an existing subscription and costs nothing per run, the other is metered against an API key. A subscription to a provider's chat product does not supply an API key for it.

**Blocked by:** 11 (Summarize on demand) — the summary flow must work with a single default model first

**Status:** ready-for-agent

- [ ] Models are listed from a runtime fetch, filtered through an allowlist, and cached
- [ ] Each option shows whether it bills against a subscription or an API key
- [ ] Options needing a key that is not configured are visible but disabled, with a hint on how to configure it
- [ ] An API key can be set in settings, stored with owner-only permission, and is never returned by the server or written to the database
- [ ] Changing the default affects later wrap-ups; a per-summary override affects only that run
- [ ] Provider selection sits behind one interface, so adding a provider does not touch the summary flow
