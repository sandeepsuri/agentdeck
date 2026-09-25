// Turns one provider CLI invocation's raw output into a normalized probe
// outcome (ticket E00). Every field shape read here was captured from a real
// installed CLI (Claude Code 2.1.282, codex-cli 0.155.1) — see
// docs/decisions/0001-first-personal-task-provider.md for the probes.
//
// Allowance is only ever what the provider itself reported. Claude's
// `total_cost_usd` is a list-price estimate even on a subscription, and token
// counts say nothing about how much of a plan's window remains, so neither is
// turned into an allowance figure.

export type ProbeStatus =
  | 'ok'
  | 'signed-out'
  | 'allowance-reached'
  | 'network-unavailable'
  | 'invalid-schema'
  | 'interrupted'
  | 'failed';

export interface AllowanceWindow {
  /** Claude's own window name (`five_hour`, `seven_day`), or a Codex window duration (`5h`, `7d`). */
  window: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ProbeOutcome {
  status: ProbeStatus;
  reason: string;
  structuredOutput?: unknown;
  tokens?: { input: number; output: number };
  allowance?: AllowanceWindow[];
  /** Provider retries or reconnects the CLI reported before the outcome. */
  retries?: number;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJsonLines(stdout: string): Json[] {
  const records: Json[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const record = obj(JSON.parse(trimmed));
      if (record) records.push(record);
    } catch {
      // Non-JSON log lines interleave with events on some CLI builds.
    }
  }
  return records;
}

function describeExit(exit: ProcessExit): string {
  return exit.signal ? `signal ${exit.signal}` : `exit ${exit.code ?? 'unknown'}`;
}

function epochToIso(seconds: unknown): string | undefined {
  const value = num(seconds);
  return value === undefined ? undefined : new Date(value * 1000).toISOString();
}

function allowanceWindow(window: string, usedPercent: number, resetsAtEpoch: unknown): AllowanceWindow {
  const resetsAt = epochToIso(resetsAtEpoch);
  return { window, usedPercent, ...(resetsAt ? { resetsAt } : {}) };
}

function claudeAllowance(info: Json): AllowanceWindow[] {
  const result: AllowanceWindow[] = [];
  for (const [name, raw] of Object.entries(obj(info.unifiedWindows) ?? {})) {
    const utilization = num(obj(raw)?.utilization);
    if (utilization !== undefined) result.push(allowanceWindow(name, Math.round(utilization * 100), obj(raw)?.resetsAt));
  }
  return result;
}

function claudeTokens(usage: Json | undefined): ProbeOutcome['tokens'] {
  if (!usage) return undefined;
  const input = (num(usage.input_tokens) ?? 0)
    + (num(usage.cache_creation_input_tokens) ?? 0)
    + (num(usage.cache_read_input_tokens) ?? 0);
  return { input, output: num(usage.output_tokens) ?? 0 };
}

export function interpretClaudeStream(stdout: string, exit: ProcessExit): ProbeOutcome {
  let allowance: AllowanceWindow[] | undefined;
  let allowanceRejected = false;
  let retries = 0;
  let result: Json | undefined;
  for (const record of parseJsonLines(stdout)) {
    if (record.type === 'rate_limit_event') {
      const info = obj(record.rate_limit_info);
      if (info) {
        allowance = claudeAllowance(info);
        // Only `allowed` has been observed live; `rejected` is inferred from
        // the sibling `overageStatus: "rejected"` vocabulary.
        allowanceRejected = info.status === 'rejected';
      }
    } else if (record.type === 'system' && record.subtype === 'api_retry') {
      retries += 1;
    } else if (record.type === 'result') {
      result = record;
    }
  }

  const tokens = claudeTokens(obj(result?.usage));
  const extras = {
    ...(tokens ? { tokens } : {}),
    ...(allowance ? { allowance } : {}),
    retries,
  };
  if (!result) {
    // A missing result means the turn never finished. Retries with no result
    // are the CLI waiting on the network (observed offline: ~10 retries over
    // ~3 minutes); otherwise something stopped it mid-turn.
    if (retries > 0) {
      return { status: 'network-unavailable', reason: `No result after ${retries} provider retries (${describeExit(exit)}).`, ...extras };
    }
    return { status: 'interrupted', reason: `Stopped before a result (${describeExit(exit)}).`, ...extras };
  }
  // `subtype` stays 'success' on a failed turn (observed signed out), so
  // is_error is the only trustworthy failure flag.
  if (result?.is_error === true) {
    const message = str(result.result) ?? 'Claude reported an error.';
    const status: ProbeStatus = allowanceRejected
      ? 'allowance-reached'
      : /not logged in|please run \/login/i.test(message) ? 'signed-out' : 'failed';
    return { status, reason: message, ...extras };
  }
  return { status: 'ok', reason: 'Completed.', structuredOutput: result?.structured_output, ...extras };
}

function parseJsonText(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Codex wraps a provider rejection as pretty-printed JSON inside `message`; the inner message is the readable one. */
function codexErrorMessage(message: string): { text: string; code?: string } {
  const inner = obj(obj(parseJsonText(message))?.error);
  const text = str(inner?.message);
  return text ? { text, ...(str(inner?.code) ? { code: str(inner?.code) } : {}) } : { text: message };
}

function classifyCodexFailure(message: string): ProbeStatus {
  const { code } = codexErrorMessage(message);
  if (code === 'invalid_json_schema') return 'invalid-schema';
  if (/\b401 Unauthorized\b|not logged in/i.test(message)) return 'signed-out';
  return 'failed';
}

export function interpretCodexExec(stdout: string, exit: ProcessExit): ProbeOutcome {
  let lastMessage: string | undefined;
  let completed: Json | undefined;
  let failure: string | undefined;
  let retries = 0;
  let waitingForNetwork = false;
  for (const record of parseJsonLines(stdout)) {
    const item = obj(record.item);
    if (record.type === 'item.completed' && item?.type === 'agent_message') {
      lastMessage = str(item.text);
    } else if (record.type === 'turn.completed') {
      completed = record;
    } else if (record.type === 'turn.failed') {
      failure = str(obj(record.error)?.message) ?? 'Codex reported a failed turn.';
    } else if (record.type === 'error') {
      const message = str(record.message) ?? '';
      if (message.startsWith('Reconnecting...')) {
        retries += 1;
        if (message.includes('waiting for network')) waitingForNetwork = true;
      }
    }
  }

  if (failure !== undefined) {
    return { status: classifyCodexFailure(failure), reason: codexErrorMessage(failure).text, retries };
  }
  // codex exits 0 when SIGTERM'd mid-turn, so only turn.completed proves the
  // turn finished.
  if (!completed) {
    if (waitingForNetwork) {
      return { status: 'network-unavailable', reason: `Still waiting for the network after ${retries} reconnects (${describeExit(exit)}).`, retries };
    }
    return { status: 'interrupted', reason: `Stopped before turn.completed (${describeExit(exit)}).`, retries };
  }
  const usage = obj(completed.usage);
  const tokens = usage ? { input: num(usage.input_tokens) ?? 0, output: num(usage.output_tokens) ?? 0 } : undefined;
  return {
    status: 'ok',
    reason: 'Completed.',
    structuredOutput: parseJsonText(lastMessage),
    ...(tokens ? { tokens } : {}),
    retries,
  };
}

export interface CodexAllowance {
  planType?: string;
  /** True only when codex names a reached limit or refuses ordinary usage. */
  allowanceReached: boolean;
  allowance: AllowanceWindow[];
}

function windowName(minutes: number | undefined): string {
  if (minutes === undefined) return 'unknown';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Reads a `codex app-server` `account/rateLimits/read` result. */
export function interpretCodexRateLimits(result: unknown): CodexAllowance {
  const root = obj(result);
  const limits = obj(root?.rateLimits);
  const allowance: AllowanceWindow[] = [];
  for (const raw of [limits?.primary, limits?.secondary]) {
    const window = obj(raw);
    const usedPercent = num(window?.usedPercent);
    if (window && usedPercent !== undefined) allowance.push(allowanceWindow(windowName(num(window.windowDurationMins)), usedPercent, window.resetsAt));
  }
  const planType = str(limits?.planType);
  return {
    ...(planType ? { planType } : {}),
    allowanceReached: (limits?.rateLimitReachedType ?? null) !== null || root?.ordinaryUsageAllowed === false,
    allowance,
  };
}
