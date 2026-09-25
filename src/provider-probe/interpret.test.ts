import { describe, expect, it } from 'vitest';
import { interpretClaudeStream, interpretCodexExec, interpretCodexRateLimits } from './interpret.js';

// Event shapes follow `claude -p --output-format stream-json --verbose`
// (Claude Code 2.1.282, 2026-09-25); identifiers are invented.
const lines = (...records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n');

const claudeInit = { type: 'system', subtype: 'init', session_id: 's', tools: [], model: 'claude-haiku-4-5-20251001', apiKeySource: 'none' };
const claudeRateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1790380800, rateLimitType: 'five_hour', isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790380800 }, seven_day: { utilization: 0.03, resetsAt: 1790766000 } },
  },
};

describe('interpretClaudeStream', () => {
  it('reports the validated structured output, tokens, and the provider-reported allowance windows', () => {
    const stdout = lines(
      claudeInit,
      claudeRateLimit,
      {
        type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', total_cost_usd: 0.0285,
        usage: { input_tokens: 2, cache_creation_input_tokens: 3243, cache_read_input_tokens: 0, output_tokens: 129 },
        structured_output: { category: 'personal', reply_needed: true, summary: 'Dinner invitation.' },
      },
    );

    const outcome = interpretClaudeStream(stdout, { code: 0, signal: null });

    expect(outcome).toEqual({
      status: 'ok',
      reason: 'Completed.',
      structuredOutput: { category: 'personal', reply_needed: true, summary: 'Dinner invitation.' },
      tokens: { input: 3245, output: 129 },
      allowance: [
        { window: 'five_hour', usedPercent: 25, resetsAt: '2026-09-26T00:00:00.000Z' },
        { window: 'seven_day', usedPercent: 3, resetsAt: '2026-09-30T11:00:00.000Z' },
      ],
      retries: 0,
    });
  });

  it('treats an is_error result as signed out even though its subtype says success', () => {
    const stdout = lines(
      claudeInit,
      { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: null, result: 'Not logged in · Please run /login' },
    );

    const outcome = interpretClaudeStream(stdout, { code: 1, signal: null });

    expect(outcome.status).toBe('signed-out');
    expect(outcome.reason).toBe('Not logged in · Please run /login');
    expect(outcome.structuredOutput).toBeUndefined();
  });

  it('reports a turn stopped before its result as interrupted, whatever the exit code', () => {
    const stdout = lines(claudeInit, { type: 'assistant', message: { content: [{ type: 'text', text: 'Backing up photos matters because' }] } });

    const outcome = interpretClaudeStream(stdout, { code: 143, signal: null });

    expect(outcome.status).toBe('interrupted');
    expect(outcome.structuredOutput).toBeUndefined();
  });

  it('reports a turn stuck in provider retries as network-unavailable and counts the retries', () => {
    const retry = (attempt: number) => ({ type: 'system', subtype: 'api_retry', error: 'unknown', attempt, retry_delay_ms: 500, max_retries: 10 });
    const stdout = lines(claudeInit, retry(1), retry(2), retry(3));

    const outcome = interpretClaudeStream(stdout, { code: null, signal: 'SIGTERM' });

    expect(outcome).toMatchObject({ status: 'network-unavailable', retries: 3 });
  });

  it('reports a failed turn after a rejected rate-limit window as allowance-reached', () => {
    // Not observed live: `status: "rejected"` is inferred from the observed
    // `status: "allowed"` and `overageStatus: "rejected"` vocabulary.
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1790380800 } } } };
    const stdout = lines(claudeInit, rejected, { type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached' });

    const outcome = interpretClaudeStream(stdout, { code: 1, signal: null });

    expect(outcome).toMatchObject({ status: 'allowance-reached', allowance: [{ window: 'five_hour', usedPercent: 100 }] });
  });

  it('does not call an unrelated error that mentions authentication signed out', () => {
    const stdout = lines(claudeInit, { type: 'result', subtype: 'success', is_error: true, result: 'Tool authentication helper failed to start' });

    expect(interpretClaudeStream(stdout, { code: 1, signal: null }).status).toBe('failed');
  });
});

// Event shapes follow `codex exec --json --output-schema` (codex-cli 0.155.1,
// 2026-09-25); identifiers are invented.
const codexStarted = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }];

describe('interpretCodexExec', () => {
  it('parses the schema-constrained final message and reports tokens without inventing an allowance', () => {
    const stdout = lines(
      ...codexStarted,
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"category":"personal","reply_needed":true,"summary":"Dinner invitation."}' } },
      { type: 'turn.completed', usage: { input_tokens: 17714, cached_input_tokens: 0, output_tokens: 56, reasoning_output_tokens: 14 } },
    );

    const outcome = interpretCodexExec(stdout, { code: 0, signal: null });

    expect(outcome).toEqual({
      status: 'ok',
      reason: 'Completed.',
      structuredOutput: { category: 'personal', reply_needed: true, summary: 'Dinner invitation.' },
      tokens: { input: 17714, output: 56 },
      retries: 0,
    });
  });

  it('reports a turn with no turn.completed as interrupted even when codex exits 0 after SIGTERM', () => {
    const stdout = lines(...codexStarted);

    const outcome = interpretCodexExec(stdout, { code: 0, signal: null });

    expect(outcome.status).toBe('interrupted');
    expect(outcome.structuredOutput).toBeUndefined();
  });

  it('classifies a 401 turn failure as signed out and counts the reconnects codex spent on it', () => {
    const unauthorized = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
    const stdout = lines(
      ...codexStarted,
      { type: 'error', message: `Reconnecting... 2/5 (${unauthorized})` },
      { type: 'error', message: `Reconnecting... 3/5 (${unauthorized})` },
      { type: 'error', message: unauthorized },
      { type: 'turn.failed', error: { message: unauthorized } },
    );

    const outcome = interpretCodexExec(stdout, { code: 1, signal: null });

    expect(outcome).toEqual({ status: 'signed-out', reason: unauthorized, retries: 2 });
  });

  it('classifies a schema the provider rejects as invalid-schema rather than a model failure', () => {
    const rejected = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_json_schema', message: "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false." }, status: 400 }, null, 2);
    const stdout = lines(...codexStarted, { type: 'error', message: rejected }, { type: 'turn.failed', error: { message: rejected } });

    const outcome = interpretCodexExec(stdout, { code: 1, signal: null });

    expect(outcome.status).toBe('invalid-schema');
    expect(outcome.reason).toBe("Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.");
  });

  it('reports a turn still waiting for the network when stopped as network-unavailable', () => {
    const waiting = { type: 'error', message: 'Reconnecting... waiting for network (Connection failed: error sending request)' };
    const stdout = lines(...codexStarted, waiting, waiting, waiting);

    const outcome = interpretCodexExec(stdout, { code: null, signal: 'SIGTERM' });

    expect(outcome).toMatchObject({ status: 'network-unavailable', retries: 3 });
  });
});

describe('interpretCodexRateLimits', () => {
  it('reads the allowance codex app-server reports without spending a turn', () => {
    // Shape of an `account/rateLimits/read` result; values invented.
    const result = {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: 'codex', planType: 'plus', rateLimitReachedType: null,
        primary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: 1790524542 },
        secondary: null,
      },
    };

    expect(interpretCodexRateLimits(result)).toEqual({
      planType: 'plus',
      allowanceReached: false,
      allowance: [{ window: '7d', usedPercent: 84, resetsAt: '2026-09-27T15:55:42.000Z' }],
    });
  });

  it('says the allowance is reached when the provider names a reached limit', () => {
    const result = {
      ordinaryUsageAllowed: false,
      rateLimits: { planType: 'plus', rateLimitReachedType: 'primary', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790380800 }, secondary: null },
    };

    expect(interpretCodexRateLimits(result)).toMatchObject({
      allowanceReached: true,
      allowance: [{ window: '5h', usedPercent: 100 }],
    });
  });
});
