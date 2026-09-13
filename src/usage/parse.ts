// Pure line parsers for the two CLIs' local logs. Each takes complete JSONL
// lines (the indexer never hands over a partial trailing line) and returns
// normalized UsageEvents; malformed lines are skipped, never thrown.
//
// Claude Code: ~/.claude/projects/**/*.jsonl — an assistant line carries
// message.{id, model, usage}. One API message is written across several
// lines (one per content block), all repeating the same message.id, so the
// store upserts on that key rather than summing lines.
//
// Codex: ~/.codex/sessions/**/rollout-*.jsonl — session_meta names the
// session, turn_context names the model for the turns that follow, and
// event_msg/token_count carries per-turn usage in last_token_usage. The same
// token_count is often emitted twice (e.g. a rate-limit refresh), which the
// cumulative total_token_usage.total_tokens exposes — only a changed total
// is a new turn. OpenAI's input_tokens includes cached tokens.
import path from 'node:path';
import type { RateLimitSnapshot, RateLimitWindow, UsageEvent } from './types.js';

type Json = Record<string, unknown>;

function parseLine(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
  } catch {
    return undefined;
  }
}

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseClaudeLines(lines: readonly string[], filePath: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const line of lines) {
    // Cheap pre-filter: most lines are tool output or user turns.
    if (!line.includes('"usage"')) continue;
    const record = parseLine(line);
    if (!record || record.type !== 'assistant') continue;
    const message = obj(record.message);
    const usage = obj(message?.usage);
    const model = str(message?.model);
    const occurredAt = str(record.timestamp);
    if (!message || !usage || !model || model === '<synthetic>' || !occurredAt) continue;
    const eventKey = str(message.id) ?? str(record.requestId) ?? str(record.uuid);
    if (!eventKey) continue;
    const cacheCreation = obj(usage.cache_creation);
    const totalWrites = num(usage.cache_creation_input_tokens);
    const writes1h = Math.min(totalWrites, num(cacheCreation?.ephemeral_1h_input_tokens));
    events.push({
      provider: 'claude',
      eventKey,
      sessionId: str(record.sessionId) ?? path.basename(filePath, '.jsonl'),
      model,
      cwd: str(record.cwd),
      occurredAt,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: totalWrites - writes1h,
      cacheWrite1hTokens: writes1h,
      reasoningTokens: num(obj(usage.output_tokens_details)?.thinking_tokens),
      speed: str(usage.speed),
    });
  }
  return events;
}

/** Running per-file Codex state, persisted between incremental scans. */
export interface CodexFileState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  lastTotal?: number;
}

export interface CodexParseResult {
  events: UsageEvent[];
  state: CodexFileState;
  rateLimits?: RateLimitSnapshot;
}

function rateWindow(value: unknown): RateLimitWindow | undefined {
  const window = obj(value);
  if (!window || typeof window.used_percent !== 'number') return undefined;
  const resetsAt = typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000).toISOString() : undefined;
  return { usedPercent: window.used_percent, windowMinutes: num(window.window_minutes), ...(resetsAt ? { resetsAt } : {}) };
}

export function parseCodexLines(lines: readonly string[], filePath: string, initial: CodexFileState = {}): CodexParseResult {
  const state: CodexFileState = { ...initial };
  const events: UsageEvent[] = [];
  // Spawned subagent threads log token_count before their first
  // turn_context; those turns take the first model named afterwards.
  const awaitingModel: UsageEvent[] = [];
  let rateLimits: RateLimitSnapshot | undefined;
  for (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    const payload = obj(record.payload);
    if (!payload) continue;
    if (record.type === 'session_meta') {
      state.sessionId = str(payload.id) ?? str(payload.session_id) ?? state.sessionId;
      state.cwd = str(payload.cwd) ?? state.cwd;
      continue;
    }
    if (record.type === 'turn_context') {
      state.model = str(payload.model) ?? state.model;
      if (state.model) for (const event of awaitingModel.splice(0)) event.model = state.model;
      state.cwd = str(payload.cwd) ?? state.cwd;
      continue;
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const occurredAt = str(record.timestamp);
    const limits = obj(payload.rate_limits);
    if (limits && occurredAt) {
      const primary = rateWindow(limits.primary);
      const secondary = rateWindow(limits.secondary);
      if (primary || secondary) {
        rateLimits = {
          provider: 'codex',
          ...(str(limits.plan_type) ? { planType: str(limits.plan_type) } : {}),
          ...(primary ? { primary } : {}),
          ...(secondary ? { secondary } : {}),
          observedAt: occurredAt,
        };
      }
    }
    const info = obj(payload.info);
    const total = num(obj(info?.total_token_usage)?.total_tokens);
    const last = obj(info?.last_token_usage);
    if (!info || !last || !occurredAt || total === 0 || total === state.lastTotal) continue;
    state.lastTotal = total;
    const sessionId = state.sessionId ?? path.basename(filePath, '.jsonl');
    const input = num(last.input_tokens);
    // Like cached reads, cache writes are a priced subset of input_tokens.
    const cached = Math.min(input, num(last.cached_input_tokens));
    const written = Math.min(input - cached, num(last.cache_write_input_tokens));
    const event: UsageEvent = {
      provider: 'codex',
      eventKey: `${sessionId}:${total}`,
      sessionId,
      model: state.model ?? 'unknown',
      cwd: state.cwd,
      occurredAt,
      inputTokens: input - cached - written,
      outputTokens: num(last.output_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      cacheWrite1hTokens: 0,
      reasoningTokens: num(last.reasoning_output_tokens),
    };
    events.push(event);
    if (!state.model) awaitingModel.push(event);
  }
  return { events, state, ...(rateLimits ? { rateLimits } : {}) };
}
