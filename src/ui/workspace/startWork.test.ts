import { describe, expect, it } from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import { quickSessionName, resolveQuickAgent, resolveStructuredRuntimes } from './startWork.js';

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
