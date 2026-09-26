import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { periodStart, UsageQueries } from './aggregate.js';
import { DEFAULT_PRICING } from './pricing.js';
import type { UsageEvent } from './types.js';

let store: Store;

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    provider: 'claude', eventKey: Math.random().toString(36), sessionId: 's1', model: 'claude-sonnet-5', cwd: '/repos/app',
    occurredAt: '2026-09-12T10:00:00.000Z', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0,
    cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, ...overrides,
  };
}

function seed(events: UsageEvent[]) {
  store.usage.commitFileScan({ path: '/x.jsonl', provider: 'claude', size: 1, mtimeMs: 1, offset: 1 }, events);
}

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { store.close(); });

describe('UsageQueries', () => {
  // Local noon on Saturday 2026-09-12; the week starts Monday 09-07.
  const now = new Date(2026, 8, 12, 12, 0, 0);
  const queries = () => new UsageQueries({ repository: store.usage, getPricing: () => DEFAULT_PRICING, now: () => now });

  it('computes local calendar period starts', () => {
    expect(periodStart('week', now)).toEqual(new Date(2026, 8, 7));
    expect(periodStart('month', now)).toEqual(new Date(2026, 8, 1));
    expect(periodStart('year', now)).toEqual(new Date(2026, 0, 1));
  });

  it('summarizes periods against the same elapsed span of the previous one', () => {
    seed([
      event({ occurredAt: new Date(2026, 8, 12, 9).toISOString() }),
      event({ occurredAt: new Date(2026, 8, 11, 9).toISOString() }), // yesterday, before the same hour
      event({ occurredAt: new Date(2026, 8, 11, 20).toISOString() }), // yesterday, after it — not compared
    ]);
    const today = queries().summary().periods.find((period) => period.period === 'today')!;
    expect(today.current.events).toBe(1);
    expect(today.previous.events).toBe(1);
    // Sonnet 5: $2/M input, $10/M output.
    expect(today.current.inputCostUsd).toBeCloseTo(2);
    expect(today.current.outputCostUsd).toBeCloseTo(1);
  });

  it('buckets by local week and fills empty buckets with zeros', () => {
    seed([
      event({ occurredAt: new Date(2026, 8, 8, 9).toISOString() }),
      event({ provider: 'codex', model: 'gpt-5.5', occurredAt: new Date(2026, 8, 12, 9).toISOString() }),
      event({ occurredAt: new Date(2026, 7, 25, 9).toISOString() }),
    ]);
    const points = queries().timeseries('week', '30d');
    const current = points.find((point) => point.bucket === '2026-09-07')!;
    expect(current.claude.events).toBe(1);
    expect(current.codex.events).toBe(1);
    expect(points.find((point) => point.bucket === '2026-08-31')).toMatchObject({ claude: { events: 0 }, codex: { events: 0 } });
  });

  it('ranks models by share and marks unpriced ones', () => {
    seed([
      event({ model: 'claude-opus-5', inputTokens: 3_000_000 }),
      event({ provider: 'codex', model: 'codex-auto-review', inputTokens: 900_000, outputTokens: 0 }),
    ]);
    const models = queries().models('30d');
    expect(models.map((model) => model.model)).toEqual(['claude-opus-5', 'codex-auto-review']);
    expect(models[1]).toMatchObject({ priced: false, costUsd: 0, unpricedTokens: 900_000 });
    expect(models.reduce((sum, model) => sum + model.share, 0)).toBeCloseTo(1);
  });

  it('rolls sessions up across models with separate input and output costs', () => {
    seed([
      event({ sessionId: 'a', model: 'claude-opus-5', occurredAt: new Date(2026, 8, 10).toISOString() }),
      event({ sessionId: 'a', model: 'claude-sonnet-5', occurredAt: new Date(2026, 8, 11).toISOString() }),
      event({ sessionId: 'b', occurredAt: new Date(2026, 8, 9).toISOString() }),
    ]);
    const [first, second] = queries().sessions('30d');
    expect(first).toMatchObject({ sessionId: 'a', models: expect.arrayContaining(['claude-opus-5', 'claude-sonnet-5']), cwd: '/repos/app' });
    expect(first?.inputCostUsd).toBeCloseTo(5 + 2);
    expect(first?.outputCostUsd).toBeCloseTo(2.5 + 1);
    expect(second?.sessionId).toBe('b');
  });

  it('projects indexed monthly and exact provider plus session usage, including partial pricing', () => {
    seed([
      event({ provider: 'claude', sessionId: 'same', model: 'claude-sonnet-5' }),
      event({ provider: 'claude', sessionId: 'same', model: 'unpriced-model', inputTokens: 50, outputTokens: 0 }),
      event({ provider: 'codex', sessionId: 'same', model: 'gpt-5', inputTokens: 20, outputTokens: 0 }),
      event({ provider: 'codex', sessionId: 'old', occurredAt: '2026-08-12T10:00:00.000Z' }),
    ]);
    const result = queries().companion([{ provider: 'claude', sessionId: 'same' }, { provider: 'codex', sessionId: 'same' }]);
    expect(result.month.events).toBe(3);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.find((row) => row.provider === 'claude')).toMatchObject({
      models: expect.arrayContaining(['claude-sonnet-5', 'unpriced-model']), unpricedTokens: 50,
    });
    expect(result.sessions.find((row) => row.provider === 'codex')?.totalTokens).toBe(20);
    expect(queries().companion([{ provider: 'codex', sessionId: 'absent' }]).sessions).toEqual([]);
  });
});
