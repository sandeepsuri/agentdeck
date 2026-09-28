import { describe, expect, it } from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { RateLimitSnapshot } from '../../usage/types.js';
import { planHeadroom, quickSessionName, resolveAskAgent, resolveQuickAgent, resolveStructuredRuntimes } from './startWork.js';

function report(statuses: { codex: 'managed' | 'compatibility-only' | 'unavailable'; claude: 'managed' | 'compatibility-only' | 'unavailable' }): RuntimeReadinessReport {
  return {
    checkedAt: '2026-09-10T00:00:00.000Z',
    runtimes: (['codex', 'claude'] as const).map((runtime) => ({
      runtime, displayName: runtime, status: statuses[runtime], reason: `${runtime} ${statuses[runtime]}`, capabilities: [],
    })),
  };
}

describe('resolveQuickAgent', () => {
  it('uses the chosen agent directly', () => {
    expect(resolveQuickAgent('codex', null)).toBe('codex');
  });

  it('picks the first installed agent for Auto, preferring Claude', () => {
    expect(resolveQuickAgent('auto', null)).toBe('claude');
    expect(resolveQuickAgent('auto', report({ codex: 'managed', claude: 'compatibility-only' }))).toBe('claude');
    expect(resolveQuickAgent('auto', report({ codex: 'managed', claude: 'unavailable' }))).toBe('codex');
  });
});

describe('resolveStructuredRuntimes', () => {
  it('offers every managed-ready runtime for Auto', () => {
    expect(resolveStructuredRuntimes('auto', null)).toEqual(['codex', 'claude']);
    expect(resolveStructuredRuntimes('auto', report({ codex: 'managed', claude: 'compatibility-only' }))).toEqual(['codex']);
  });

  it('keeps an explicit choice only when it can run managed work', () => {
    expect(resolveStructuredRuntimes('claude', report({ codex: 'managed', claude: 'managed' }))).toEqual(['claude']);
    expect(resolveStructuredRuntimes('claude', report({ codex: 'managed', claude: 'unavailable' }))).toEqual([]);
  });
});

describe('quickSessionName', () => {
  it('names the session from the first line of the task', () => {
    expect(quickSessionName('  Fix the flaky auth test\nIt fails on CI')).toBe('Fix the flaky auth test');
    expect(quickSessionName('')).toBeUndefined();
    expect(quickSessionName('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
  });
});

describe('resolveAskAgent', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const codex = (weeklyUsed: number, resetsAt = '2026-10-02T00:00:00.000Z'): RateLimitSnapshot => ({
    provider: 'codex', observedAt: '2026-09-27T11:00:00.000Z',
    primary: { usedPercent: 5, windowMinutes: 300 }, secondary: { usedPercent: weeklyUsed, windowMinutes: 10_080, resetsAt },
  });

  it('keeps Claude first when no limits are known', () => {
    expect(resolveAskAgent(null, [], now)).toBe('claude');
  });

  it('moves off a provider whose weekly plan is nearly spent', () => {
    expect(resolveAskAgent(null, [codex(97)], now)).toBe('claude');
    expect(resolveAskAgent(null, [codex(97), { ...codex(20), provider: 'claude' }], now)).toBe('claude');
  });

  it('picks the provider with the most plan left when both are known', () => {
    expect(resolveAskAgent(null, [codex(20), { ...codex(70), provider: 'claude' }], now)).toBe('codex');
  });

  it('prefers a known-low provider over nothing, and skips uninstalled ones', () => {
    expect(resolveAskAgent(report({ codex: 'managed', claude: 'unavailable' }), [codex(99)], now)).toBe('codex');
    expect(resolveAskAgent(report({ codex: 'unavailable', claude: 'managed' }), [codex(0)], now)).toBe('claude');
  });

  it('treats a window whose reset has passed as refilled', () => {
    expect(planHeadroom(codex(100, '2026-09-26T00:00:00.000Z'), now)).toBe(95);
    expect(planHeadroom(codex(100), now)).toBe(0);
    expect(planHeadroom(undefined, now)).toBeUndefined();
  });
});
