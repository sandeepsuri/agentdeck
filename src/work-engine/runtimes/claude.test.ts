import { describe, expect, it } from 'vitest';
import { createFakeClaudeCli } from '../../test-fixtures/claude-attempt.js';
import type { EnvelopeProfile } from '../types.js';
import { describeRuntimeAttemptAdapterContract } from './adapter.contract.js';
import type { AttemptLaunchContext } from './adapter.js';
import { createClaudeAttemptAdapter } from './claude.js';

const profile: EnvelopeProfile = {
  writableWorktree: '/repos/example-runs/run-1',
  readableRoots: ['/repos/example-runs/run-1'],
  allowedNetworkDomains: ['api.anthropic.com', 'console.anthropic.com'],
  environmentAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL'],
  processCeiling: 16,
  childRunCeiling: 0,
};

const context: AttemptLaunchContext = {
  runId: 'run-1',
  objective: 'Add the missing regression test',
  acceptanceCriteria: ['A failing case now passes'],
  worktreePath: profile.writableWorktree,
  profile,
};

describeRuntimeAttemptAdapterContract([
  {
    name: 'claude (successful turn)',
    context,
    expectOutcome: 'completion',
    createAdapter: () => createClaudeAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-claude',
      spawn: createFakeClaudeCli({ behavior: 'success' }).spawn,
    }),
  },
  {
    name: 'claude (turn failure)',
    context,
    expectOutcome: 'failure',
    createAdapter: () => createClaudeAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-claude',
      spawn: createFakeClaudeCli({ behavior: 'turn-failure' }).spawn,
    }),
  },
]);

async function run(adapterOptions: Parameters<typeof createClaudeAttemptAdapter>[0]) {
  const adapter = createClaudeAttemptAdapter(adapterOptions);
  const events: import('../types.js').AttemptEvent[] = [];
  for await (const event of adapter.run(context)) events.push(event);
  return events;
}

describe('createClaudeAttemptAdapter', () => {
  it('reports Claude Code as unavailable rather than hanging when it is not installed', async () => {
    const events = await run({ resolveExecutable: () => undefined });
    expect(events).toEqual([
      { kind: 'lifecycle', sequence: 0, at: expect.any(String), phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: expect.any(String), reason: expect.stringContaining('not installed') },
    ]);
  });

  it('maps a successful turn into ordered lifecycle, tool-activity, message, usage, and completion events', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(events.map((event) => event.kind)).toEqual([
      'lifecycle', 'lifecycle', 'tool-activity', 'tool-activity', 'message', 'usage', 'completion',
    ]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-activity', tool: 'Bash', status: 'started', summary: 'npm test' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-activity', tool: 'Bash', status: 'completed', summary: 'npm test' }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'message', role: 'assistant', text: 'Added the missing test and confirmed it passes.',
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage', inputTokens: 1200, outputTokens: 340 }));
    expect(events.at(-1)).toMatchObject({ kind: 'completion', outcome: 'success', summary: 'Added the missing test and confirmed it passes.' });
  });

  it('never records the model\'s own thinking as activity', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    const tools = events.filter((event) => event.kind === 'tool-activity').map((event) => event.tool);
    expect(tools).toEqual(['Bash', 'Bash']);
    expect(JSON.stringify(events)).not.toContain('Deciding where the test belongs');
  });

  it('reports missing usage as unknown rather than zero', async () => {
    const fake = createFakeClaudeCli({ behavior: 'missing-usage' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    const usage = events.find((event) => event.kind === 'usage');
    expect(usage).toMatchObject({ inputTokens: 'unknown', outputTokens: 'unknown' });
  });

  it('surfaces a turn-level failure precisely, ending the Attempt', async () => {
    const fake = createFakeClaudeCli({ behavior: 'turn-failure' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(events.some((event) => event.kind === 'completion')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'failure', reason: 'The sandboxed command exited non-zero.' });
  });

  it('reports an unexpected exit as a failure instead of hanging forever', async () => {
    const fake = createFakeClaudeCli({ behavior: 'silent-exit' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(events.at(-1)).toMatchObject({ kind: 'failure', reason: expect.stringContaining('exited before completing') });
  });

  it('reports an exit before any result as a failure instead of hanging forever', async () => {
    const fake = createFakeClaudeCli({ behavior: 'exit-without-result' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(events.at(-1)).toMatchObject({ kind: 'failure', reason: expect.stringContaining('exited before completing') });
  });

  it('never puts the Claude provider conversation id (session_id) on any event', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success', sessionId: 'session-secret-identity' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(JSON.stringify(events)).not.toContain('session-secret-identity');
  });

  it('launches the process with only the envelope-allowlisted environment — never the full host environment', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    process.env.AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK = 'top-secret';
    try {
      await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });
    } finally {
      delete process.env.AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK;
    }

    expect(fake.envs).toHaveLength(1);
    expect(fake.envs[0]).not.toHaveProperty('AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK');
    expect(Object.keys(fake.envs[0]!).every((key) => profile.environmentAllowlist.includes(key))).toBe(true);
  });

  it('sends the objective and acceptance criteria as the one stream-json user message, inside the worktree', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(fake.writes).toHaveLength(1);
    const sent = JSON.parse(fake.writes[0]!);
    expect(sent).toMatchObject({ type: 'user', message: { role: 'user' } });
    const text = sent.message.content[0].text as string;
    expect(text).toContain(context.objective);
    expect(text).toContain(context.acceptanceCriteria[0]);
  });

  it('launches claude in non-interactive stream-json mode, isolated from the operator\'s own settings and MCP servers', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(fake.argv).toEqual([[
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompts', 'none',
      '--setting-sources', '',
      '--strict-mcp-config',
    ]]);
  });
});
