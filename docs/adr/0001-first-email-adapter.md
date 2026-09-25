---
status: proposed — accepted once the live gate below passes
---

# First email adapter: Gmail API with an owner-created OAuth client

The first Everyday email route targets one account type: the owner's personal `@gmail.com` account, used from their own Mac. For that account, AgentDeck will use the **Gmail REST API**, authorized through a **Desktop OAuth client the owner creates in their own Google Cloud project**, with the scopes `gmail.readonly` and `gmail.compose`. Its deciding property is that `drafts.send` consumes the draft in the same provider operation that creates the sent message. A draft that still exists therefore proves a send did not happen, so an uncertain send can be settled from provider evidence instead of by guessing. IMAP/SMTP cannot give that proof, and Apple Mail cannot give it either. Public distribution with an AgentDeck-owned OAuth client is deferred.

The spike is in [`scripts/spikes/email/`](../../scripts/spikes/email/README.md). Production code must not assume a Gmail scope or an Apple Mail automation path beyond what this record allows.

## Spike evidence

`npx tsx scripts/spikes/email/run.ts fake` runs the same send-exactly-once protocol against both provider semantics. The protocol persists the intent before the effect, reconciles an unobserved outcome against the provider, reopens an intent only on proof of absence, and otherwise leaves it `ambiguous` for the owner to resolve. All 13 scenarios pass with no duplicate send.

| Case | Draft-consuming (Gmail API) | Submit-then-cleanup (IMAP/SMTP) |
|---|---|---|
| Response lost after commit | sent, 1 copy | sent, 1 copy |
| Failure before commit, then retry | proven not sent → retried → 1 copy | **ambiguous** (draft survival proves nothing) |
| Crash after commit, resume from journal | sent, 1 copy | not scenario-tested; same Sent search as a lost response |
| Sent index lags past settle window | ambiguous (draft gone, Sent not yet indexed) | ambiguous |
| Provider rewrites Message-ID | found by `X-AgentDeck-Intent` in thread | no fallback |
| Owner deleted the draft first | ambiguous, 0 copies | ambiguous, 0 copies |
| Double tap | 1 dispatch | 1 dispatch |

A deliberate mutation that retries a failed send blindly produces duplicate sends only under submit-then-cleanup. A draft-consuming send cannot be replayed after it succeeds.

## Candidates

| | Gmail API (chosen) | IMAP + SMTP, app password | Apple Mail automation |
|---|---|---|---|
| Compatible accounts | Consumer Gmail; Workspace only if the admin allows the client | Consumer Gmail with 2-Step Verification, iCloud, Fastmail, Yahoo. Not Outlook.com or Microsoft 365 (basic auth removed in 2024–25), not Advanced Protection, not Workspace where the admin disables app passwords | Any account configured in Mail.app |
| Minimum permissions | `gmail.readonly` (search, read, search Sent; `gmail.metadata` cannot use `q`) + `gmail.compose` (drafts and draft send). Both are Google **restricted** scopes | Whole mailbox read/write/delete plus send; no scoping. App password is account-wide and revoked on password change | macOS Automation (TCC) consent for Mail; Mail must be running |
| Setup friction | High for the pilot: create a Cloud project, enable the API, set up the consent screen, create a Desktop client, download JSON, then consent past the "unverified app" screen | Low: turn on 2-Step Verification, create an app password, store it in the Keychain | Low: one Automation prompt |
| Lookup | Gmail search syntax, thread IDs | `SEARCH` per mailbox; Gmail threads only through `X-GM-*` extensions | AppleScript `whose` queries; slow on large mailboxes |
| Draft edit | `drafts.update` keeps the draft ID | Append new version, then expunge old: two steps, and the ID changes | Outgoing message is editable only while the compose window exists |
| Uncertain-send reconciliation | Strong: Sent search by Message-ID or intent header, plus positive proof of absence | Sent search only; absence is never provable | Weak: `send` returns only a boolean, and the script cannot set Message-ID or custom headers, so matching falls back to subject, recipient, and time |
| Pilot distribution | Owner-created client under Google's personal-use allowance (fewer than 100 users, unverified warning) | Nothing to register | Needs the `com.apple.security.automation.apple-events` entitlement and `NSAppleEventsUsageDescription` in the signed app |
| Public distribution | AgentDeck-owned client needs brand verification plus restricted-scope verification (several weeks), and likely an annual CASA security assessment because message content reaches a model provider | Unchanged, but Google discourages app passwords and they may be withdrawn | Same entitlement; no provider review |

IMAP/SMTP remains the fallback if the live gate fails. It would need owner-resolved ambiguity after any failed submission, and it gives up scoped permissions. Apple Mail is rejected on its documented capabilities: exact-once reconciliation needs a message identity the script cannot set. It was not driven live, to avoid triggering a TCC prompt on the owner's Mac. Microsoft Graph is the likely route for Outlook.com and Microsoft 365 later, but it is out of scope for this account type.

## Consequences

- **Pilot setup** is owner-created OAuth. Keep the consent screen **In production** (unverified): the Testing status expires authorizations after 7 days, which would force a weekly repair state. Store the refresh token in the Keychain rather than the spike's `0600` file.
- **Send path (#89)**: create the draft, persist the intent with the draft ID, Message-ID, and `X-AgentDeck-Intent`, then call `drafts.send`. On any unobserved outcome, reconcile by Sent search first and the draft's existence second. Surface `ambiguous` to the owner; never auto-resend.
- **Draft path (#88)**: an edit is `drafts.update` on the same draft ID. Read the draft back before showing the decision card, so the approved digest matches what the provider holds.
- **Cleanup**: the minimum scopes cannot trash mail. Removing test artifacts is manual (`subject:"agentdeck-spike"`), or would need `gmail.modify`, which this record does not grant.

## Live gate (unresolved)

This record moves to **accepted** after `run.ts live gmail-api` passes on the owner's account with `lose-response-after-commit`, `fail-before-commit`, and `crash-after-commit` + `resume`. A pass requires 1 sent copy, a correct final state, and three confirmed observations: `draftGoneAfterSend: true`, the reply stays in its thread, and the draft reads back exactly. The live run must also answer two open questions:

- Does Gmail keep the requested Message-ID on drafts and sent mail (`draftKeepsRequestedMessageId`, `sentKeepsRequestedMessageId`)? If not, reconciliation relies on the thread intent-header path.
- How long does Sent-index lag take in practice (`lookup.indexLag`)? That sets the settle window.

If `drafts.send` turns out not to consume the draft atomically, re-evaluate IMAP/SMTP or defer email.

Before any public distribution, also resolve how Google's Limited Use requirements treat sending message content to a model provider.
