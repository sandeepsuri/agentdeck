// The `codex app-server` protocol facts the Codex adapter (codex.ts) depends
// on, written down in one place so a test can check them against what the
// installed CLI actually generates.
//
// Why this module exists: two protocol guesses in a row shipped green. The
// adapter and its fixture (test-fixtures/codex-attempt.ts) were written from
// the same assumptions, so a wrong method name or payload path was certified
// by the suite rather than caught — 'thread/sendMessage' (a method the
// app-server does not expose) and then a top-level `threadId` on the
// thread/start response (the id is nested under `thread`). A fixture can only
// confirm that the adapter agrees with itself. The snapshot in
// test-fixtures/codex-protocol-snapshot.json, generated from
// `codex app-server generate-json-schema` by scripts/snapshot-codex-protocol.mjs,
// is the outside evidence; codex-protocol.conformance.test.ts compares the two.
//
// Paths are dotted, and arrays are transparent ('input.text' is the `text` of
// an element of `input'). A 'field=value' entry pins a string enum member, so
// discriminators like an item's `type` or an approval `decision` are checked
// by value and not merely by name.

export interface CodexProtocolSnapshot {
  readonly codexVersion: string;
  /** Every method name the app-server accepts from a client. */
  readonly clientRequests: readonly string[];
  /** Params paths, for the requests AgentDeck sends. */
  readonly requestParams: Readonly<Record<string, readonly string[]>>;
  /** Result paths, for the responses AgentDeck reads a value out of. */
  readonly responses: Readonly<Record<string, readonly string[]>>;
  readonly serverNotifications: Readonly<Record<string, readonly string[]>>;
  readonly serverRequests: Readonly<Record<string, {
    readonly params: readonly string[];
    readonly response: readonly string[];
  }>>;
  readonly threadItemTypes: readonly string[];
}

export type CodexProtocolSurface =
  | 'request-params'
  | 'response'
  | 'notification'
  | 'server-request-params'
  | 'server-request-response'
  | 'thread-item-type';

export interface CodexProtocolContractEntry {
  /** Stable key — what KNOWN_PROTOCOL_GAPS refers to. */
  readonly id: string;
  readonly surface: CodexProtocolSurface;
  /** The JSON-RPC method this entry is about; omitted for 'thread-item-type', which is method-independent. */
  readonly method?: string;
  /** Paths (or `field=value` enum members) the adapter relies on. Empty means "the method must exist at all". */
  readonly expects: readonly string[];
  /** Where in codex.ts this dependency lives, for whoever reads a failure. */
  readonly usedBy: string;
}

export const CODEX_PROTOCOL_CONTRACT: readonly CodexProtocolContractEntry[] = [
  {
    id: 'initialize-params',
    surface: 'request-params',
    method: 'initialize',
    expects: ['clientInfo.name', 'clientInfo.version', 'capabilities.experimentalApi'],
    usedBy: "the initialize handshake — experimentalApi is what unlocks thread/start's runtimeWorkspaceRoots",
  },
  {
    id: 'thread-start-params',
    surface: 'request-params',
    method: 'thread/start',
    expects: ['cwd', 'approvalPolicy=on-request', 'sandbox=workspace-write', 'runtimeWorkspaceRoots'],
    usedBy: 'the thread/start request that pins the Attempt to its worktree',
  },
  {
    id: 'thread-start-response-id',
    surface: 'response',
    method: 'thread/start',
    expects: ['thread.id'],
    usedBy: 'readThreadId() — the provider conversation id, which never leaves this module',
  },
  {
    id: 'turn-start-params',
    surface: 'request-params',
    method: 'turn/start',
    expects: ['threadId', 'input.type=text', 'input.text'],
    usedBy: 'the objective-carrying request',
  },
  {
    id: 'turn-started-notification',
    surface: 'notification',
    method: 'turn/started',
    expects: [],
    usedBy: "handleNotification — mapped to the 'turn-started' lifecycle event",
  },
  {
    id: 'item-started-notification',
    surface: 'notification',
    method: 'item/started',
    expects: ['item.type', 'item.command', 'item.path', 'item.query', 'item.changes.path', 'item.tool'],
    usedBy: 'handleNotification/itemSummary — tool-activity events',
  },
  {
    id: 'item-completed-notification',
    surface: 'notification',
    method: 'item/completed',
    expects: ['item.type', 'item.text', 'item.status=failed', 'item.status=declined', 'item.status=interrupted'],
    usedBy: 'handleNotification — assistant messages and completed/failed tool activity',
  },
  {
    id: 'item-types',
    surface: 'thread-item-type',
    expects: ['agentMessage', 'userMessage', 'reasoning'],
    usedBy: "handleNotification — the answer, and the two item types that are not actions",
  },
  {
    id: 'token-usage-notification',
    surface: 'notification',
    method: 'thread/tokenUsage/updated',
    expects: ['tokenUsage.total.inputTokens', 'tokenUsage.total.outputTokens'],
    usedBy: 'handleNotification — usage events',
  },
  {
    id: 'turn-completed-outcome',
    surface: 'notification',
    method: 'turn/completed',
    expects: ['turn.status=completed', 'turn.status=failed', 'turn.status=interrupted', 'turn.error.message'],
    usedBy: 'handleNotification — decides completion vs failure',
  },
  {
    id: 'session-error-notification',
    surface: 'notification',
    method: 'session/error',
    expects: ['message'],
    usedBy: 'handleNotification — session-level failure',
  },
  {
    id: 'command-approval-params',
    surface: 'server-request-params',
    method: 'item/commandExecution/requestApproval',
    expects: ['command'],
    usedBy: 'describeAttentionRequest — the human-readable approval reason',
  },
  {
    id: 'command-approval-response',
    surface: 'server-request-response',
    method: 'item/commandExecution/requestApproval',
    expects: ['decision=approved', 'decision=denied'],
    usedBy: 'buildAttentionResponseResult — the operator decision relayed back to Codex',
  },
  {
    id: 'user-input-response',
    surface: 'server-request-response',
    method: 'item/tool/requestUserInput',
    expects: ['value'],
    usedBy: 'buildAttentionResponseResult — clarifying input relayed back to Codex',
  },
];

export interface CodexProtocolGap {
  readonly id: string;
  readonly why: string;
}

// The contract entries that are known NOT to match the installed app-server,
// left in place deliberately while the fix for each is scoped separately.
// The conformance test asserts the violation set equals this list exactly, so
// a NEW mismatch fails immediately, and closing one of these without removing
// it from this list fails too. Do not add to this list to silence a failure:
// a new entry here means shipping a known-broken protocol assumption.
export const KNOWN_PROTOCOL_GAPS: readonly CodexProtocolGap[] = [
  {
    id: 'session-error-notification',
    why: "The notification is 'error', with params { error: TurnError, threadId, turnId, willRetry }; a fix should honour willRetry rather than failing a retryable error.",
  },
  {
    id: 'command-approval-response',
    why: "Decisions are 'accept' | 'acceptForSession' | 'decline' | 'cancel', not 'approved'/'denied'. An approval reply is rejected today, stalling the turn.",
  },
  {
    id: 'user-input-response',
    why: "The reply is { answers: { [questionId]: { answers: string[] } } }, keyed by the ids in the request's `questions`, not { value }.",
  },
];

export type CodexProtocolViolationReason = 'unknown-method' | 'missing-paths';

export interface CodexProtocolViolation {
  readonly id: string;
  readonly subject: string;
  readonly reason: CodexProtocolViolationReason;
  readonly missing: readonly string[];
  /** A few entries from the same neighbourhood, so a failure suggests where the real path went. */
  readonly nearby: readonly string[];
}

const MAX_NEARBY = 8;

/** Collapses a path to comparable letters, so 'threadId' and 'thread.id' — a field that moved into a nested object — line up. */
function normalizePath(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Paths worth pointing at when an expected one is absent: those sharing a
 * segment with it ('decision' finds 'decision=accept'), and those that read
 * the same once flattened ('threadId' finds 'thread.id', 'error.message'
 * finds 'turn.error.message'). Both drift shapes we have actually hit.
 */
function nearbyPaths(available: readonly string[], missing: readonly string[]): string[] {
  const stems = new Set(missing.flatMap((path) => path.split(/[.=]/)));
  const normalized = missing.map(normalizePath);
  const flattenedMatch = (path: string): boolean => {
    const candidate = normalizePath(path);
    return normalized.some((target) => candidate.includes(target) || target.includes(candidate));
  };
  const matches = available.filter((path) => flattenedMatch(path) || path.split(/[.=]/).some((segment) => stems.has(segment)));
  // Closest first: a path that reads the same once flattened is the answer far
  // more often than a same-stem sibling, and shorter beats deeper. Without
  // this, 'turn.error.message' loses its place to eight codexErrorInfo leaves.
  return matches
    .sort((left, right) => (Number(flattenedMatch(right)) - Number(flattenedMatch(left))) || (left.length - right.length))
    .slice(0, MAX_NEARBY);
}

function lookUp(
  snapshot: CodexProtocolSnapshot,
  entry: CodexProtocolContractEntry,
): { subject: string; available: readonly string[] } | undefined {
  const method = entry.method ?? '';
  switch (entry.surface) {
    case 'request-params':
      return snapshot.clientRequests.includes(method)
        ? { subject: `client request ${method}`, available: snapshot.requestParams[method] ?? [] }
        : undefined;
    case 'response':
      return snapshot.responses[method]
        ? { subject: `response to ${method}`, available: snapshot.responses[method]! }
        : undefined;
    case 'notification':
      return snapshot.serverNotifications[method]
        ? { subject: `notification ${method}`, available: snapshot.serverNotifications[method]! }
        : undefined;
    case 'server-request-params':
      return snapshot.serverRequests[method]
        ? { subject: `server request ${method} params`, available: snapshot.serverRequests[method]!.params }
        : undefined;
    case 'server-request-response':
      return snapshot.serverRequests[method]
        ? { subject: `reply to server request ${method}`, available: snapshot.serverRequests[method]!.response }
        : undefined;
    case 'thread-item-type':
      return { subject: 'ThreadItem type', available: snapshot.threadItemTypes };
    default:
      return undefined;
  }
}

/** Every contract entry the snapshot does not support: an unknown method, or paths the payload does not carry. */
export function findCodexProtocolViolations(
  snapshot: CodexProtocolSnapshot,
  contract: readonly CodexProtocolContractEntry[] = CODEX_PROTOCOL_CONTRACT,
): CodexProtocolViolation[] {
  const violations: CodexProtocolViolation[] = [];
  for (const entry of contract) {
    const found = lookUp(snapshot, entry);
    if (!found) {
      violations.push({
        id: entry.id,
        subject: `${entry.surface} ${entry.method ?? ''}`.trim(),
        reason: 'unknown-method',
        missing: [entry.method ?? ''],
        nearby: [],
      });
      continue;
    }
    const missing = entry.expects.filter((path) => !found.available.includes(path));
    if (missing.length > 0) {
      violations.push({
        id: entry.id,
        subject: found.subject,
        reason: 'missing-paths',
        missing,
        nearby: nearbyPaths(found.available, missing),
      });
    }
  }
  return violations;
}

export function describeCodexProtocolViolation(violation: CodexProtocolViolation): string {
  const detail = violation.reason === 'unknown-method'
    ? 'the installed app-server exposes no such method'
    : `missing ${violation.missing.join(', ')}${violation.nearby.length > 0 ? ` — the snapshot offers ${violation.nearby.join(', ')}` : ''}`;
  return `${violation.id} (${violation.subject}): ${detail}`;
}

/**
 * The Codex thread id from a `thread/start` result.
 *
 * ThreadStartResponse is { thread: Thread, cwd, model, … } — the id is nested
 * under `thread`, never a top-level `threadId`. Returns undefined rather than
 * throwing so the caller can fail the Attempt with its own precise reason.
 */
export function readThreadId(result: Record<string, unknown>): string | undefined {
  const thread = result.thread;
  if (typeof thread !== 'object' || thread === null) return undefined;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
