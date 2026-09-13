import { describe, expect, it } from 'vitest';
import { parseClaudeLines, parseCodexLines } from './parse.js';

const claudeLine = (overrides: { id?: string; output?: number; model?: string } = {}) => JSON.stringify({
  type: 'assistant', sessionId: 'claude-session', cwd: '/repos/app', timestamp: '2026-09-10T12:00:00.000Z', requestId: 'req_1',
  message: {
    id: overrides.id ?? 'msg_1', model: overrides.model ?? 'claude-opus-5',
    usage: {
      input_tokens: 10, output_tokens: overrides.output ?? 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1500,
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 }, output_tokens_details: { thinking_tokens: 40 }, speed: 'standard',
    },
  },
});

describe('parseClaudeLines', () => {
  it('normalizes an assistant usage line and splits 1-hour cache writes', () => {
    const [event] = parseClaudeLines([claudeLine()], '/x/claude-session.jsonl');
    expect(event).toMatchObject({
      provider: 'claude', eventKey: 'msg_1', sessionId: 'claude-session', model: 'claude-opus-5', cwd: '/repos/app',
      inputTokens: 10, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 500, cacheWrite1hTokens: 1000, reasoningTokens: 40, speed: 'standard',
    });
  });

  it('keeps one key per message so repeated content-block lines dedupe downstream', () => {
    const events = parseClaudeLines([claudeLine({ output: 3 }), claudeLine({ output: 200 })], '/x/s.jsonl');
    expect(new Set(events.map((event) => event.eventKey))).toEqual(new Set(['msg_1']));
  });

  it('skips malformed, non-assistant, and synthetic lines', () => {
    const events = parseClaudeLines([
      '{"type":"assistant","usage"', // truncated
      JSON.stringify({ type: 'user', message: { usage: {} } }),
      claudeLine({ model: '<synthetic>' }),
    ], '/x/s.jsonl');
    expect(events).toEqual([]);
  });
});

const codex = {
  meta: (id = 'codex-session') => JSON.stringify({ timestamp: '2026-09-10T12:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/repos/api' } }),
  turn: (model: string) => JSON.stringify({ timestamp: '2026-09-10T12:00:01.000Z', type: 'turn_context', payload: { model, cwd: '/repos/api' } }),
  tokens: (total: number, last: { input: number; cached: number; output: number }, limits = true) => JSON.stringify({
    timestamp: '2026-09-10T12:00:02.000Z', type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output, reasoning_output_tokens: 7 },
      },
      ...(limits ? { rate_limits: { plan_type: 'plus', primary: { used_percent: 42, window_minutes: 300, resets_at: 1_789_000_000 } } } : {}),
    },
  }),
};

describe('parseCodexLines', () => {
  it('counts each changed cumulative total once and subtracts cached input', () => {
    const result = parseCodexLines([
      codex.meta(), codex.turn('gpt-5.5'),
      codex.tokens(1000, { input: 900, cached: 400, output: 100 }),
      codex.tokens(1000, { input: 900, cached: 400, output: 100 }), // duplicate emission
      codex.tokens(2500, { input: 1300, cached: 1000, output: 200 }),
    ], '/x/rollout.jsonl');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ eventKey: 'codex-session:1000', model: 'gpt-5.5', inputTokens: 500, cacheReadTokens: 400, outputTokens: 100, reasoningTokens: 7 });
    expect(result.state).toMatchObject({ sessionId: 'codex-session', model: 'gpt-5.5', lastTotal: 2500 });
    expect(result.rateLimits).toMatchObject({ provider: 'codex', planType: 'plus', primary: { usedPercent: 42, windowMinutes: 300 } });
  });

  it('attributes model switches to the turns that follow them', () => {
    const { events } = parseCodexLines([
      codex.meta(), codex.turn('gpt-5.5'), codex.tokens(10, { input: 5, cached: 0, output: 5 }, false),
      codex.turn('gpt-5.4'), codex.tokens(30, { input: 15, cached: 0, output: 5 }, false),
    ], '/x/rollout.jsonl');
    expect(events.map((event) => event.model)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('backfills turns logged before the first turn_context (subagent threads)', () => {
    const { events } = parseCodexLines([
      codex.meta(), codex.tokens(10, { input: 5, cached: 0, output: 5 }, false), codex.turn('gpt-5.4'),
    ], '/x/rollout.jsonl');
    expect(events[0]?.model).toBe('gpt-5.4');
  });

  it('resumes from carried state across incremental scans', () => {
    const first = parseCodexLines([codex.meta(), codex.turn('gpt-5.5'), codex.tokens(1000, { input: 900, cached: 0, output: 100 })], '/x/r.jsonl');
    const second = parseCodexLines([codex.tokens(1000, { input: 900, cached: 0, output: 100 }), codex.tokens(1600, { input: 500, cached: 0, output: 100 })], '/x/r.jsonl', first.state);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ sessionId: 'codex-session', model: 'gpt-5.5', eventKey: 'codex-session:1600' });
  });
});
