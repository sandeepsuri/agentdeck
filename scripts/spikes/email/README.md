# Email adapter spike (issue #78)

This is a throwaway harness that runs the same four operations against each candidate email adapter: message lookup, draft create/edit/read-back, exact send, and provider-side reconciliation of an uncertain send. The decision it supports is recorded in [`docs/adr/0001-first-email-adapter.md`](../../../docs/adr/0001-first-email-adapter.md). Nothing here is imported by AgentDeck.

| File | Purpose |
|---|---|
| `types.ts` | The adapter contract shared by every candidate |
| `protocol.ts`, `journal.ts` | Send-exactly-once: persist intent → dispatch → reconcile; no blind retries |
| `faults.ts` | Injects a lost response, a pre-commit failure, or a crash around a real send |
| `fake-provider.ts`, `fake-scenarios.ts` | Deterministic scenarios for draft-consuming vs submit-then-cleanup providers |
| `gmail-api.ts` | Candidate A: Gmail REST API, owner-created Desktop OAuth client |
| `imap-smtp.ts` | Candidate B: IMAP + SMTP with an app password in the login Keychain |
| `run.ts` | CLI entry point |

## Deterministic run (no account needed)

```bash
npx tsx scripts/spikes/email/run.ts fake
```

The command exits non-zero if any scenario ends in the wrong state or leaves more sent copies than allowed.

## Live runs

A live run sends only to the authenticated mailbox itself. `run.ts` refuses any other recipient. Each run sends two messages tagged `[agentdeck-spike <runId>]`: a seed message and a threaded reply.

Credentials, tokens, the send-intent journal, and results live in `~/.agentdeck/spikes/email/` (owner-only; override with `AGENTDECK_EMAIL_SPIKE_DIR`). The harness refuses to use a directory inside the repository.

### Gmail API

1. In Google Cloud Console, create a project and enable the Gmail API.
2. Configure the OAuth consent screen as **External** and add yourself as a test user. For refresh tokens that last longer than 7 days, set the publishing status to **In production**. The app stays unverified, which is allowed for personal use.
3. Create an OAuth client of type **Desktop app** and download its JSON to `~/.agentdeck/spikes/email/gmail-oauth-client.json`.
4. Authorize, then run each fault:

```bash
npx tsx scripts/spikes/email/run.ts gmail-auth
npx tsx scripts/spikes/email/run.ts live gmail-api --fault lose-response-after-commit
npx tsx scripts/spikes/email/run.ts live gmail-api --fault fail-before-commit
npx tsx scripts/spikes/email/run.ts live gmail-api --fault crash-after-commit   # exits 75
npx tsx scripts/spikes/email/run.ts resume gmail-api
```

### IMAP + SMTP (app password)

Two-Step Verification must be on. Create an app password, then store it:

```bash
security add-generic-password -s agentdeck-email-spike -a you@gmail.com -w
AGENTDECK_MAIL_USER=you@gmail.com npx tsx scripts/spikes/email/run.ts live imap-smtp --fault lose-response-after-commit
```

For other providers, set `AGENTDECK_IMAP_HOST`, `AGENTDECK_SMTP_HOST`, `AGENTDECK_IMAP_DRAFTS`, and `AGENTDECK_IMAP_SENT`. Set `AGENTDECK_IMAP_APPEND_SENT=1` if the provider does not file SMTP submissions into Sent.

### Inspecting and cleaning up

```bash
npx tsx scripts/spikes/email/run.ts status             # every recorded send intent
npx tsx scripts/spikes/email/run.ts cleanup gmail-api  # deletes leftover spike drafts
rm -rf ~/.agentdeck/spikes/email                       # removes tokens, journal, and results
```

The minimum Gmail scopes cannot trash mail, so remove sent spike messages by hand with the Gmail search `subject:"agentdeck-spike"`. Revoke the spike's Google access at <https://myaccount.google.com/permissions> and delete the app password when you're done.
