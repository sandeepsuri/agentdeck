import { describe, expect, it } from 'vitest';
import { costOf, DEFAULT_PRICING, parsePricingOverrides, resolvePrice } from './pricing.js';

const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

describe('resolvePrice', () => {
  it('matches exact ids, then the longest separator-bounded prefix', () => {
    expect(resolvePrice('claude-fable-5-1', DEFAULT_PRICING)?.cacheRead).toBe(0.25);
    expect(resolvePrice('claude-haiku-4-5-20251001', DEFAULT_PRICING)?.input).toBe(1);
    expect(resolvePrice('gpt-5.5', DEFAULT_PRICING)?.input).toBe(5);
  });

  it('never lets a short key price a different model family', () => {
    expect(resolvePrice('gpt-5.9-experimental', DEFAULT_PRICING)).toBeUndefined();
    expect(resolvePrice('codex-auto-review', DEFAULT_PRICING)).toBeUndefined();
  });
});

describe('costOf', () => {
  it('splits input-side (including cache) and output cost', () => {
    const price = resolvePrice('claude-opus-5', DEFAULT_PRICING)!;
    const cost = costOf({ ...tokens, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 }, price);
    expect(cost.inputCostUsd).toBeCloseTo(5 + 0.5 + 6.25 + 10);
    expect(cost.outputCostUsd).toBeCloseTo(25);
  });

  it('uses fast-mode rates when a response ran fast', () => {
    const price = resolvePrice('claude-opus-5', DEFAULT_PRICING)!;
    expect(costOf({ ...tokens, speed: 'fast' }, price)).toEqual({ inputCostUsd: 10, outputCostUsd: 50 });
  });
});

describe('parsePricingOverrides', () => {
  it('accepts well-formed entries, derives cache rates, and drops the rest', () => {
    expect(parsePricingOverrides({ 'my-model': { input: 2, output: 8 }, broken: { input: 'x' }, other: null })).toEqual({
      'my-model': { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
    });
    expect(parsePricingOverrides('nope')).toBeUndefined();
  });
});
