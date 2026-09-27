// Issue #85: turning what a provider CLI printed during a harmless readiness
// check into one of the setup states, and each state into repair steps. The
// fixtures follow the shapes observed from Claude Code 2.1.283 and
// codex-cli 0.157.1 (docs/decisions/0001); identities are invented.
import { describe, expect, it } from 'vitest';
import {
  assessClaudeReadiness,
  assessCodexReadiness,
  parseClaudeUsageWindows,
  repairFor,
  type ClaudeEvidence,
  type CodexEvidence,
} from './readiness.js';

const SIGNED_IN_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: '00000000-0000-4000-8000-000000000000',
  orgName: "someone@example.com's Organization",
  subscriptionType: 'pro',
});
const SIGNED_OUT_STATUS = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

function usage(result: string, isError = false): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, num_turns: 0, local_command: 'usage', result });
}

const SUBSCRIPTION_USAGE = usage('You are currently using your subscription to power your Claude Code usage\n\n'
  + 'Current session: 3% used · resets Sep 27 at 9:10pm (America/Toronto)\n'
  + 'Current week (all models): 28% used · resets Sep 30 at 7am (America/Toronto)\n\nWhat’s contributing…');

function claude(overrides: Partial<ClaudeEvidence> = {}): ClaudeEvidence {
  return {
    installed: true,
    version: '2.1.283 (Claude Code)',
    authStatus: { exitCode: 0, stdout: SIGNED_IN_STATUS },
    usage: { exitCode: 0, stdout: SUBSCRIPTION_USAGE },
    ...overrides,
  };
}

function codex(overrides: Partial<CodexEvidence> = {}): CodexEvidence {
  return {
    installed: true,
    version: 'codex-cli 0.157.1',
    loginStatus: { exitCode: 0, stdout: 'Logged in using ChatGPT' },
    rateLimits: {
      result: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1791055818 },
          secondary: null, planType: 'plus', rateLimitReachedType: null,
        },
      },
    },
    ...overrides,
  };
}

describe('parseClaudeUsageWindows', () => {
  it('reads each "Current …: N% used" line and its reset text', () => {
    expect(parseClaudeUsageWindows('Current session: 3% used · resets Sep 27 at 9:10pm (America/Toronto)\nCurrent week (all models): 100% used · resets Sep 30 at 7am'))
      .toEqual([
        { window: 'Current session', usedPercent: 3, resetsAt: 'Sep 27 at 9:10pm (America/Toronto)' },
        { window: 'Current week (all models)', usedPercent: 100, resetsAt: 'Sep 30 at 7am' },
      ]);
  });
});

describe('assessClaudeReadiness', () => {
  it('is ready when the sign-in and the subscription allowance both answer', () => {
    const result = assessClaudeReadiness(claude());
    expect(result).toMatchObject({ state: 'ready', cliVersion: '2.1.283', authMethod: 'claude.ai', plan: 'pro' });
    expect(result.allowance).toHaveLength(2);
  });

  it('never carries the account email, organization, or config paths', () => {
    expect(JSON.stringify(assessClaudeReadiness(claude()))).not.toMatch(/example\.com|00000000|Organization|\.claude/);
  });

  it('asks for the CLI when it is not installed', () => {
    expect(assessClaudeReadiness({ installed: false }).state).toBe('missing-cli');
  });

  it('is signed out when auth status says so', () => {
    expect(assessClaudeReadiness(claude({ authStatus: { exitCode: 1, stdout: SIGNED_OUT_STATUS } })).state).toBe('signed-out');
  });

  it('is expired when the provider refuses the stored sign-in', () => {
    const failed = usage('OAuth token has expired. Please run /login', true);
    expect(assessClaudeReadiness(claude({ usage: { exitCode: 1, stdout: failed } })).state).toBe('expired');
  });

  it('reports a reached allowance with the reset time the provider gave', () => {
    const full = usage('Current session: 100% used · resets Sep 27 at 9:10pm\nCurrent week (all models): 40% used · resets Sep 30 at 7am');
    const result = assessClaudeReadiness(claude({ usage: { exitCode: 0, stdout: full } }));
    expect(result.state).toBe('allowance-reached');
    expect(result.detail).toContain('Sep 27 at 9:10pm');
  });

  it('does not guess expiry when the subscription answers with only a cost summary', () => {
    const cost = usage('Total cost:            $0.0000\nTotal duration (API):  0s');
    const result = assessClaudeReadiness(claude({ usage: { exitCode: 0, stdout: cost } }));
    expect(result.state).toBe('check-failed');
    expect(result.detail).toMatch(/sign in again/);
  });

  it('fails the check, without guessing sign-out, when the CLI output is unreadable or times out', () => {
    expect(assessClaudeReadiness(claude({ authStatus: { exitCode: null, stdout: '', failure: 'timed out' } })).state).toBe('check-failed');
    expect(assessClaudeReadiness(claude({ usage: { exitCode: 0, stdout: usage('Unable to reach the usage service.') } })).state).toBe('check-failed');
  });

  it('accepts a Console (API usage billing) sign-in without an allowance figure', () => {
    const console = JSON.stringify({ loggedIn: true, authMethod: 'console' });
    const result = assessClaudeReadiness(claude({
      authStatus: { exitCode: 0, stdout: console },
      usage: { exitCode: 0, stdout: usage('Total cost: $0.0000') },
    }));
    expect(result).toMatchObject({ state: 'ready', authMethod: 'console' });
    expect(result.allowance).toBeUndefined();
  });
});

describe('assessCodexReadiness', () => {
  it('is ready with the plan and allowance the provider reported', () => {
    expect(assessCodexReadiness(codex())).toMatchObject({
      state: 'ready', cliVersion: '0.157.1', authMethod: 'chatgpt', plan: 'plus',
      allowance: [{ window: '7d', usedPercent: 34 }],
    });
  });

  it('asks for the CLI when it is not installed', () => {
    expect(assessCodexReadiness({ installed: false }).state).toBe('missing-cli');
  });

  it('reads the sign-in method codex prints on stderr', () => {
    expect(assessCodexReadiness(codex({ loginStatus: { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' } })).authMethod).toBe('chatgpt');
  });

  it('is signed out when login status fails', () => {
    expect(assessCodexReadiness(codex({ loginStatus: { exitCode: 1, stdout: 'Not logged in' } })).state).toBe('signed-out');
  });

  it('is expired when the stored sign-in is refused', () => {
    const refused = codex({ rateLimits: { error: 'codex account authentication required to read rate limits' } });
    expect(assessCodexReadiness(refused).state).toBe('expired');
  });

  it('reports a reached allowance', () => {
    const reached = codex({ rateLimits: { result: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 }, rateLimitReachedType: 'primary' } } } });
    expect(assessCodexReadiness(reached).state).toBe('allowance-reached');
  });

  it('fails the check when the allowance read does not answer', () => {
    expect(assessCodexReadiness(codex({ rateLimits: { error: 'no answer within 15 seconds', timedOut: true } })).state).toBe('check-failed');
  });

  it('accepts an API-key sign-in without an allowance figure', () => {
    const apiKey = codex({ loginStatus: { exitCode: 0, stdout: 'Logged in using an API key - sk-***' }, rateLimits: { error: 'chatgpt authentication required' } });
    expect(assessCodexReadiness(apiKey)).toMatchObject({ state: 'ready', authMethod: 'api-key' });
    expect(JSON.stringify(assessCodexReadiness(apiKey))).not.toContain('sk-');
  });
});

describe('repairFor', () => {
  it('offers the in-app official installer for Claude Code and a guided page for Codex', () => {
    expect(repairFor('claude', 'missing-cli').actions).toEqual(['install', 'check']);
    expect(repairFor('codex', 'missing-cli').actions).toEqual(['open-install-guide', 'check']);
  });

  it('sends signed-out and expired sign-ins to the provider’s own sign-in', () => {
    expect(repairFor('claude', 'signed-out').actions).toEqual(['sign-in']);
    expect(repairFor('codex', 'expired').actions).toEqual(['sign-in', 'check']);
    expect(repairFor('claude', 'expired').steps.join(' ')).toMatch(/sign in again/i);
  });

  it('lets a reached allowance wait for its reset instead of signing in again', () => {
    expect(repairFor('claude', 'allowance-reached').actions).toEqual(['check']);
  });

  it('has nothing to repair when ready', () => {
    expect(repairFor('codex', 'ready')).toEqual({ title: expect.any(String), steps: [], actions: ['check'] });
  });
});
