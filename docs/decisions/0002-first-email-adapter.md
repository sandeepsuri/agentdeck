# 0002 — First email adapter: Gmail API with an owner-created OAuth client

**Status:** Proposed. It becomes accepted once the live gate below passes on the owner's account.
**Date:** 2026-09-25
**Ticket:** Everyday 03 (#78)

## Decision

The first Everyday email route targets one account type: the owner's personal `@gmail.com` account, used from their own Mac. For that account, AgentDeck will use the **Gmail REST API**, authorized through a **Desktop OAuth client the owner creates in their own Google Cloud project**, with the scopes `gmail.readonly` and `gmail.compose`.

The deciding property is that `drafts.send` consumes the draft in the same provider operation that creates the sent message. Once no request for that draft can still be in flight, a draft that still exists proves the send did not happen. An uncertain send can therefore be settled from provider evidence instead of by guessing. IMAP/SMTP cannot give that proof, and Apple Mail cannot give it either.

Public distribution with an AgentDeck-owned OAuth client is deferred. Production code must not assume a Gmail scope or an Apple Mail automation path beyond what this record allows.

The spike is in [`scripts/spikes/email/`](../../scripts/spikes/email/README.md).

## Spike evidence

`npx tsx scripts/spikes/email/run.ts fake` runs the send-exactly-once protocol against both provider semantics. The protocol works as follows:

- It persists the intent before the effect.
- It reconciles an unobserved outcome against the provider.
- It reopens an intent only on proof of absence, and only after an in-flight grace that outlasts the request timeout.
- It otherwise leaves the intent `ambiguous` for the owner to resolve.
- It never moves an intent out of `sent`.

All 21 scenarios pass with no duplicate send. These are behavioural models of the two providers, not measurements of them. Real latency, index lag, and Message-ID handling are left to the live gate.

| Case (then a retry, where noted) | Draft-consuming (Gmail API) | Submit-then-cleanup (IMAP/SMTP) |
|---|---|---|
| Response lost after commit, retry | sent, 1 copy | sent, 1 copy |
| Failure before commit, retry | proven not sent → resent → 1 copy, 2 dispatches | **ambiguous**, 0 copies |
| Client timeout, provider commits late, retry | sent, 1 copy, 1 dispatch | sent, 1 copy |
| Crash after commit, resume from journal | sent, 1 copy | sent, 1 copy |
| Sent index lags inside the settle window | sent, 1 copy | sent, 1 copy |
| Sent index lags past the settle window, retry | ambiguous, 1 copy | ambiguous, 1 copy |
| Provider rewrites Message-ID on the sent copy | sent, found by `X-AgentDeck-Intent` in thread | **ambiguous** (no second identity to search) |
| Owner deleted the draft first, retry | ambiguous, 0 copies | ambiguous, 0 copies |
| Double tap while the send is in flight | 1 dispatch, 1 copy | 1 dispatch, 1 copy |

The control run in the same command shows the other side. A client that blindly retries after a lost response leaves 1 copy under draft-consuming semantics and 2 under submit-then-cleanup. Two deliberate mutations of the protocol were each caught:

- Removing the in-flight grace makes the late-commit case dispatch twice.
- Adding a blind retry produces duplicates under submit-then-cleanup.

## Candidates

| | Gmail API (chosen) | IMAP + SMTP, app password | Apple Mail automation |
|---|---|---|---|
| Compatible accounts | Consumer Gmail; Workspace only if the admin allows the client | Consumer Gmail with 2-Step Verification, iCloud, Fastmail, Yahoo. Not Outlook.com or Microsoft 365 (basic auth removed in 2024–25), not Advanced Protection, not Workspace where the admin disables app passwords | Any account configured in Mail.app |
| Minimum permissions | `gmail.readonly` (search, read, search Sent; `gmail.metadata` cannot use `q`) + `gmail.compose` (drafts and draft send). Both are Google **restricted** scopes | Whole mailbox read/write/delete plus send; no scoping. App password is account-wide and revoked on password change | macOS Automation (TCC) consent for Mail; Mail must be running |
| Setup friction | High for the pilot: create a Cloud project, enable the API, set up the consent screen, create a Desktop client, download JSON, then consent past the "unverified app" screen | Low: turn on 2-Step Verification, create an app password, store it in the Keychain | Low: one Automation prompt |
| Lookup | Gmail search syntax, thread IDs | `SEARCH` per mailbox; Gmail threads only through `X-GM-*` extensions | AppleScript `whose` queries; slow on large mailboxes |
| Draft edit | `drafts.update` keeps the draft ID | Append new version, then expunge old: two steps, and the ID changes | Outgoing message is editable only while the compose window exists |
| Uncertain-send reconciliation | Strong: Sent search by Message-ID or intent header, plus proof of absence after the grace | Sent search by Message-ID only; absence is never provable | Weak: `send` returns only a boolean, and the script cannot set Message-ID or custom headers, so matching falls back to subject, recipient, and time |
| Pilot distribution | Owner-created client under Google's personal-use allowance (fewer than 100 users, unverified warning) | Nothing to register | Needs the `com.apple.security.automation.apple-events` entitlement and `NSAppleEventsUsageDescription` in the signed app |
| Public distribution | AgentDeck-owned client needs brand verification plus restricted-scope verification (several weeks), and likely an annual CASA security assessment because message content reaches a model provider | Unchanged, but Google discourages app passwords and they may be withdrawn | Same entitlement; no provider review |

IMAP/SMTP remains the fallback if the live gate fails. It would need owner-resolved ambiguity after any failed submission, and it gives up scoped permissions.

Apple Mail is rejected on its documented capabilities, because exact-once reconciliation needs a message identity the script cannot set. It was not driven live, to avoid triggering a TCC prompt on the owner's Mac.

Microsoft Graph is the likely route for Outlook.com and Microsoft 365 later, but it is out of scope for this account type.

## Known failed and residual cases

- **Absence cannot be proven** after a failed SMTP submission, a Sent index slower than the settle window, a rewritten Message-ID under IMAP, or an owner-deleted draft. Each ends `ambiguous` for the owner to resolve. None of them resends.
- **The grace is an assumption.** The in-flight grace (30 s by default, above the adapters' 20 s request timeout) assumes Google finishes or abandons a timed-out `drafts.send` within that window. Google documents no such bound. Even if a late commit lands after the grace, Gmail itself still prevents a second copy, because the retry finds its draft consumed. What goes wrong is the journal: it can briefly say `not_sent` and record an extra dispatch.
- **A 404 from `drafts.send`** on a draft the owner deleted is treated as an unobserved outcome and ends `ambiguous`. That is conservative, but safe.

## Consequences

- **Pilot setup** is owner-created OAuth. Keep the consent screen **In production** (unverified): the Testing status expires authorizations after 7 days, which would force a weekly repair state. Store the refresh token in the Keychain rather than the spike's `0600` file.
- **Send path (#89)**: create the draft, then persist the intent with the draft ID, Message-ID, `X-AgentDeck-Intent`, and dispatch time. Then call `drafts.send` with a request timeout below the in-flight grace. On any unobserved outcome, reconcile by Sent search first and draft existence second. Surface `ambiguous` to the owner; never auto-resend.
- **Draft path (#88)**: an edit is `drafts.update` on the same draft ID. Read the draft back before showing the decision card, so the approved digest matches what the provider holds.
- **Cleanup**: the minimum scopes cannot trash mail. Removing test artifacts is manual (`subject:"agentdeck-spike"`), or would need `gmail.modify`, which this record does not grant.

## Live gate (unresolved)

No live account was available when this record was written. It moves to **accepted** after the following passes on the owner's Gmail account:

```bash
npx tsx scripts/spikes/email/run.ts live gmail-api --fault lose-response-after-commit
npx tsx scripts/spikes/email/run.ts live gmail-api --fault fail-before-commit
npx tsx scripts/spikes/email/run.ts live gmail-api --fault crash-after-commit
npx tsx scripts/spikes/email/run.ts resume gmail-api
```

The first two runs must exit 0. A pass means exactly 1 sent copy, a final state of `sent`, the draft gone after the send, the reply kept in its thread, and an exact draft read-back. For the crash case, `resume` must report 1 copy.

The live run must also answer three open questions:

- Does Gmail keep the requested Message-ID on drafts and sent mail (`draftKeepsRequestedMessageId`, `sentKeepsRequestedMessageId`)? If not, reconciliation relies on the thread intent-header path.
- How long does Sent-index lag take in practice (`lookup.indexLag`)? That sets the settle window.
- How reliable is the route across repeated runs? The fake gives no reliability data.

If `drafts.send` turns out not to consume the draft atomically, re-evaluate IMAP/SMTP or defer email.

Before any public distribution, also resolve how Google's Limited Use requirements treat sending message content to a model provider.
