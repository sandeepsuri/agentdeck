# 0001 — First supported provider for personal tasks

**Status:** Accepted as the provider choice only. This record authorizes no personal file or account capability. That still waits on E01 confinement, and the friend release also waits on the terms gate below.
**Date:** 2026-09-25
**Ticket:** Everyday 01 / spec E00 (#76)

## Decision

**Claude Code CLI is the first provider E01 confinement and the E05 personal-task runner target.** Codex CLI stays fully supported for existing developer Runs and Sessions. It is not the first personal-task provider.

No personal-task execution is added here.

## Evidence

Run `npm run probe:providers -- --failures` on macOS 26.2 (arm64). Versions probed: Claude Code 2.1.282–2.1.283 on a **Claude Pro** plan, and codex-cli 0.155.1 on a **ChatGPT Plus** plan. Rows marked *(manual)* were observed with the one-off command shown, not by the script.

| Concern | Claude Code (`-p --output-format stream-json`) | Codex (`exec --json`) |
| --- | --- | --- |
| Tools offered on a structured, non-coding turn | `--tools ""` leaves only the synthetic `StructuredOutput` tool. No shell, no file, no web tool is offered (init event `tools`) | No flag removes the shell (`codex exec --help`). The best available setting is `--sandbox read-only`, and it still lets the shell read any file the user can read |
| Where the sign-in credential lives | A macOS Keychain item. **Any same-user process can read it without a prompt** through `security find-generic-password -s "Claude Code-credentials" -w` *(manual, byte count only)* | `~/.codex/auth.json`, a plaintext file with mode 600 that any same-user process can read. Codex can instead use the OS keyring (`cli_auth_credentials_store`); not probed |
| Structured output | `--json-schema`; the validated result arrives in `structured_output`; an ordinary schema with an optional property is accepted | `--output-schema <file>`; the result is the final `agent_message` text. A schema that is not strict (every property required, `additionalProperties: false`) is rejected with HTTP 400 `invalid_json_schema` |
| Input tokens for the same one-line classification | ~3.2k | ~15k |
| Signed out (empty config directory) | Fails in ~0.5 s: `is_error: true`, `"Not logged in · Please run /login"`. The result still says `subtype: "success"` | Retries HTTP 401 5–9 times, taking ~15 s, before `turn.failed` |
| Offline (connections refused) | `system/api_retry` events carrying attempt, max (10), and delay. It gave up after ~3 min *(manual, 150 s run)*; the script stops at 45 s | `Reconnecting... waiting for network` with no stated limit. Still waiting at 150 s *(manual)* |
| Killed mid-turn (SIGTERM) | Exit 143, no `result` event | **Exit 0**, no `turn.completed` |
| Retry after interruption | A fresh identical call succeeds | A fresh identical call succeeds |
| Allowance without spending | `claude -p /usage` answers locally (0 turns), as **text only**: "Current session: N% used", "Current week (all models): N% used" | `codex app-server` → `account/rateLimits/read`: structured `usedPercent`, window, reset time, plan type, and a reached flag |
| Allowance during a call | A `rate_limit_event` on every call, with per-window `utilization` and `resetsAt` (`five_hour`, `seven_day`) | None in `exec --json` |
| Sign-in check | `claude auth status` prints JSON (`loggedIn`, `authMethod`, `subscriptionType`) and exits 1 when signed out | `codex login status` prints text and exits 1 when signed out |

Continuing an existing conversation works on both CLIs (`--resume <id>`, `codex exec resume <id>`) *(manual)*.

### Why Claude first

1. **A model step with no effect-capable tools.** The personal-task step only reads extracted text and returns a typed proposal. On Claude it can run with no shell, file, or web tool, and the E05 broker then performs every effect. On Codex a shell is always present, so E01 would have to confine it before even the harmless step could run.
2. **Failures that show up honestly.** Claude reports sign-out immediately and retries with structured, bounded events. Codex spends ~15 s retrying a 401, waits with no limit when offline, and exits 0 when it is killed.
3. **Smaller fixed overhead** for short structured steps (~3.2k vs ~15k input tokens). This is **not** a cost or allowance claim. Both plans report utilization in whole percent per window, which is too coarse to price one task. Allowance used per completed task must be measured in the friend pilot (spec §8).

**The credential location does not favor either provider.** Both credentials can be read by any process running as the user. E01 must keep them out of reach of the personal-task process in both cases.

Codex's on-demand allowance read is better than Claude's text-only `/usage`. E08 should use `account/rateLimits/read` for Codex readiness. For Claude it should show the last observed `rate_limit_event` with its observation time, or parse `/usage` as best-effort text.

## Setup friction observed

- Both CLIs were installed here through npm under nvm, so they need Node. A non-developer cannot be asked to do that (spec §4.1). Claude has an official native installer and a Homebrew cask; Codex ships Homebrew and standalone binaries. **Neither was tried on a fresh macOS account.**
- Sign-in uses each provider's own browser flow (`claude auth login`; `codex login`, which also offers `--device-auth`). AgentDeck never handles the credential.
- Claude auto-updated from 2.1.282 to 2.1.283 in the middle of the spike. Readiness must be re-checked, not cached per version.
- Claude uses the plan's default model (Opus here) unless `--model` is passed. Personal tasks should pick a model explicitly.
- Claude's `--bare` would give the cleanest process, but it turns off OAuth and Keychain reads, so it cannot use a subscription. Use `--tools "" --setting-sources "" --strict-mcp-config --no-session-persistence` instead.
- Both CLIs wait on a piped stdin, so stdin must be closed explicitly.
- Every probe run spends a little of the signed-in plan's allowance.

## Recovery rules for the E05 runner

These are consequences of the observations above, recorded for E05; nothing here implements them.

1. Judge completion from the terminal event, not the exit code: Claude's `result` without `is_error`, and Codex's `turn.completed`.
2. AgentDeck owns the deadline, because neither CLI fails promptly when offline.
3. A retry is a new Attempt with the same input. It does not resume the provider conversation.
4. Map outcomes to the spec's actionable states: `signed-out` → "provider sign-in expired", `network-unavailable` → "provider unreachable", `allowance-reached` → "provider allowance reached".

## Unresolved gates

1. **Terms (blocks the friend release).** Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) lets an end user sign in to the *unmodified* Claude Code binary with their own subscription, including where a product runs Claude Code. It forbids third parties from offering claude.ai login, routing requests through Free/Pro/Max credentials on users' behalf, or collecting or intermediating credentials. It also says subscription OAuth supports "ordinary use" and that plan limits assume "ordinary, individual usage", and that running Claude Code in a product requires the Commercial Terms. AgentDeck fits the permitted pattern: the user's own unmodified install, the provider's own sign-in, and no credential handling. Whether a distributed personal-assistant app driving that CLI counts as ordinary individual use is **not confirmed**. Get written confirmation from Anthropic before a friend release. OpenAI's [Codex authentication docs](https://learn.chatgpt.com/docs/auth) recommend API keys for programmatic workflows, so Codex has the same open question.
2. **Confinement (E01).** `--tools ""` is a CLI flag, not an enforced boundary. E01 must prove process-level confinement of the Claude process, its children, its inherited environment, and its access to the Keychain credential.
3. **Fresh-account setup (E08).** The native installer, first browser sign-in, and relaunch recovery are untested.
4. **Other plans and exhaustion.** Only Claude Pro and ChatGPT Plus were probed. An exhausted allowance was never observed. Claude's `allowance-reached` classification assumes `rate_limit_info.status: "rejected"`, which is inferred from the observed `"allowed"` / `overageStatus: "rejected"` vocabulary. Codex's reached flag comes from the `rateLimitReachedType` field in the observed response shape.

## Reproducing

```bash
nvm use 24
npm run probe:providers                      # readiness, structured output, schema strictness, interrupt → retry
npm run probe:providers -- --failures        # adds signed-out and offline (~2 extra minutes)
npm run probe:providers -- --provider claude # one provider only
```

Each line prints `PASS`/`FAIL` against the expected outcome, and the command exits 1 if any probe fails. The redacted JSON report goes to `.scratch/provider-probes/` (gitignored) and is not committed, because it describes a real account. Before anything is written or printed, emails, UUIDs, organization and request IDs, API keys, bearer tokens, JWTs, and the home path are removed (`src/provider-probe/redact.ts`). The signed-out probe points the CLI at an empty config directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so the real sign-in is never touched. The offline probe routes through a dead local proxy. The storage probe checks only where a credential lives and never reads it.

The interpretation is covered by `src/provider-probe/interpret.test.ts`, using invented fixtures in the observed event shapes. It lives under `src/` because E05's runner and E08's readiness checks are expected to reuse it.
