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
  {
    // The same suite Codex's approval path runs through: a round that pauses
    // on an operator decision must still produce one well-formed, ordered
    // event stream ending in exactly one terminal event.
    name: 'claude (approval request, approved)',
    context: { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' as const }) },
    expectOutcome: 'completion',
    createAdapter: () => createClaudeAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-claude',
      spawn: createFakeClaudeCli({ behavior: 'permission-request' }).spawn,
    }),
  },
]);

async function run(
  adapterOptions: Parameters<typeof createClaudeAttemptAdapter>[0],
  launchContext: AttemptLaunchContext = context,
) {
  const adapter = createClaudeAttemptAdapter(adapterOptions);
  const events: import('../types.js').AttemptEvent[] = [];
  for await (const event of adapter.run(launchContext)) events.push(event);
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

  it('launches claude in non-interactive stream-json mode, isolated from the operator\'s own settings and MCP servers, with the host answering permission prompts', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    await run({
      resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn, newSessionId: () => 'session-uuid-1',
    });

    expect(fake.argv).toEqual([[
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'host',
      '--permission-prompt-tool', 'stdio',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--session-id', 'session-uuid-1',
    ]]);
  });

  it('keeps stdin open for the whole turn — a closed stdin aborts every pending permission request', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn },
      { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' }) },
    );

    expect(fake.stdinEndedDuringTurn).toEqual([false]);
  });
});

describe('createClaudeAttemptAdapter approvals (ticket 14 AC2)', () => {
  it('turns a can_use_tool control request into a durable attention-requested event with a human-readable reason, and relays approval back to Claude', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    const seen: string[] = [];
    const events = await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn },
      {
        ...context,
        awaitAttentionDecision: async (attentionId) => { seen.push(attentionId); return { kind: 'approve' }; },
      },
    );

    const requested = events.find((event) => event.kind === 'attention-requested');
    expect(requested).toMatchObject({
      kind: 'attention-requested',
      attentionKind: 'approval',
      reason: 'Claude is requesting approval to use Bash: rm -rf node_modules',
    });
    if (requested?.kind !== 'attention-requested') throw new Error('expected attention-requested');
    expect(seen).toEqual([requested.attentionId]);
    // Allow must carry the tool input back unchanged: the adapter is a relay
    // for the operator's decision, never an editor of what Claude asked to do.
    expect(fake.controlResponses).toEqual([{
      behavior: 'allow',
      updatedInput: { command: 'rm -rf node_modules', description: 'Clear installed packages' },
    }]);
    expect(events.at(-1)).toMatchObject({ kind: 'completion', outcome: 'success' });
  });

  it('mints the same attentionId for the same runtime request, and never puts the provider request id or session id on the event', async () => {
    const fake = createFakeClaudeCli({
      behavior: 'permission-request', permissionRequestId: 'provider-request-identity', sessionId: 'session-secret-identity',
    });
    const events = await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn },
      { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' }) },
    );
    const again = await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: createFakeClaudeCli({ behavior: 'permission-request', permissionRequestId: 'provider-request-identity' }).spawn },
      { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' }) },
    );

    const first = events.find((event) => event.kind === 'attention-requested');
    const second = again.find((event) => event.kind === 'attention-requested');
    if (first?.kind !== 'attention-requested' || second?.kind !== 'attention-requested') {
      throw new Error('expected attention-requested');
    }
    expect(first.attentionId).toBe(second.attentionId);
    expect(JSON.stringify(events)).not.toContain('provider-request-identity');
    expect(JSON.stringify(events)).not.toContain('session-secret-identity');
  });

  it('relays a denial back to Claude with a human-readable message rather than silently allowing it', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    const events = await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn },
      { ...context, awaitAttentionDecision: async () => ({ kind: 'deny' }) },
    );

    expect(fake.controlResponses).toEqual([
      { behavior: 'deny', message: 'The AgentDeck operator denied this action.' },
    ]);
    // The denied tool must be recorded as failed activity, never as one that ran.
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-activity', tool: 'Bash', status: 'failed', summary: 'rm -rf node_modules',
    }));
  });

  it('safely denies a permission request when no policy path is wired, instead of hanging the turn forever', async () => {
    const fake = createFakeClaudeCli({ behavior: 'permission-request' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn });

    expect(fake.controlResponses).toEqual([]);
    expect(events.some((event) => event.kind === 'attention-requested')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'completion' });
  });

  it('answers an unrecognized control request instead of leaving Claude waiting on it', async () => {
    const fake = createFakeClaudeCli({
      behavior: 'permission-request',
      permissionRequest: { subtype: 'hook_callback', callback_id: 'hook-1' },
    });
    const events = await run(
      { resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn },
      { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' }) },
    );

    expect(events.some((event) => event.kind === 'attention-requested')).toBe(false);
    expect(events.at(-1)?.kind).toBe('completion');
  });
});

describe('createClaudeAttemptAdapter continuation (ticket 14 AC2/AC4)', () => {
  it('resumes the same Claude conversation on a later round of the same Run instead of starting a new one', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const adapter = createClaudeAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn, newSessionId: () => 'session-uuid-1',
    });

    for await (const _ of adapter.run(context)) { /* drain the first round */ }
    for await (const _ of adapter.run({ ...context, objective: 'Fix the failing gate' })) { /* second round */ }

    expect(fake.argv[0]).toContain('--session-id');
    expect(fake.argv[0]).not.toContain('--resume');
    expect(fake.argv[1]).toEqual(expect.arrayContaining(['--resume', 'session-uuid-1']));
    expect(fake.argv[1]).not.toContain('--session-id');
    // A resumed round carries only its own new instruction — the acceptance
    // criteria the conversation already holds are never replayed into it.
    const first = JSON.parse(fake.writes[0]!).message.content[0].text as string;
    const second = JSON.parse(fake.writes[1]!).message.content[0].text as string;
    expect(first).toContain('Acceptance criteria:');
    expect(second).toBe('Fix the failing gate');
  });

  it('never resumes one Run\'s Claude conversation for a different Run', async () => {
    const fake = createFakeClaudeCli({ behavior: 'success' });
    const sessions = ['session-uuid-1', 'session-uuid-2'];
    const adapter = createClaudeAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-claude', spawn: fake.spawn, newSessionId: () => sessions.shift()!,
    });

    for await (const _ of adapter.run(context)) { /* run-1 */ }
    for await (const _ of adapter.run({ ...context, runId: 'run-2' })) { /* run-2 */ }

    expect(fake.argv[1]).toEqual(expect.arrayContaining(['--session-id', 'session-uuid-2']));
    expect(fake.argv[1]).not.toContain('--resume');
  });
});
