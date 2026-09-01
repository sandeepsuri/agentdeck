import { describe, expect, it } from 'vitest';
import { createFakeCodexAppServer } from '../../test-fixtures/codex-attempt.js';
import type { EnvelopeProfile } from '../types.js';
import { describeRuntimeAttemptAdapterContract } from './adapter.contract.js';
import type { AttemptLaunchContext } from './adapter.js';
import { createCodexAttemptAdapter } from './codex.js';

const profile: EnvelopeProfile = {
  writableWorktree: '/repos/example-runs/run-1',
  readableRoots: ['/repos/example-runs/run-1'],
  allowedNetworkDomains: ['api.openai.com', 'chatgpt.com'],
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
    name: 'codex (successful turn)',
    context,
    expectOutcome: 'completion',
    createAdapter: () => createCodexAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-codex',
      spawn: createFakeCodexAppServer({ behavior: 'success' }).spawn,
    }),
  },
  {
    name: 'codex (turn failure)',
    context,
    expectOutcome: 'failure',
    createAdapter: () => createCodexAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-codex',
      spawn: createFakeCodexAppServer({ behavior: 'turn-failure' }).spawn,
    }),
  },
]);

async function run(adapterOptions: Parameters<typeof createCodexAttemptAdapter>[0]) {
  const adapter = createCodexAttemptAdapter(adapterOptions);
  const events: import('../types.js').AttemptEvent[] = [];
  for await (const event of adapter.run(context)) events.push(event);
  return events;
}

describe('createCodexAttemptAdapter', () => {
  it('reports Codex as unavailable rather than hanging when it is not installed', async () => {
    const events = await run({ resolveExecutable: () => undefined });
    expect(events).toEqual([
      { kind: 'lifecycle', sequence: 0, at: expect.any(String), phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: expect.any(String), reason: expect.stringContaining('not installed') },
    ]);
  });

  it('maps a successful turn into ordered lifecycle, tool-activity, message, usage, and completion events', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(events.map((event) => event.kind)).toEqual([
      'lifecycle', 'lifecycle', 'tool-activity', 'tool-activity', 'message', 'usage', 'lifecycle', 'completion',
    ]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-activity', tool: 'command_execution', status: 'started', summary: 'npm test' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-activity', tool: 'command_execution', status: 'completed', summary: 'npm test' }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'message', role: 'assistant', text: 'Added the missing test and confirmed it passes.',
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage', inputTokens: 1200, outputTokens: 340 }));
    expect(events.at(-1)).toMatchObject({ kind: 'completion', outcome: 'success' });
  });

  it('reports missing usage as unknown rather than zero', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'missing-usage' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    const usage = events.find((event) => event.kind === 'usage');
    expect(usage).toMatchObject({ inputTokens: 'unknown', outputTokens: 'unknown' });
  });

  it('surfaces a turn-level failure precisely, ending the Attempt', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'turn-failure' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(events.at(-1)).toMatchObject({ kind: 'failure', reason: 'The sandboxed command exited non-zero.' });
  });

  it('surfaces a handshake failure (e.g. sandbox unavailable) without ever starting a turn', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'handshake-failure' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(events).toEqual([
      { kind: 'lifecycle', sequence: 0, at: expect.any(String), phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: expect.any(String), reason: expect.stringContaining('sandbox unavailable') },
    ]);
  });

  it('reports an unexpected exit as a failure instead of hanging forever', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'silent-exit' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(events.at(-1)).toMatchObject({ kind: 'failure', reason: expect.stringContaining('exited before completing') });
  });

  it('never puts the Codex provider conversation id (threadId) on any event', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success', threadId: 'thread-secret-identity' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(JSON.stringify(events)).not.toContain('thread-secret-identity');
  });

  it('launches the process with only the envelope-allowlisted environment — never the full host environment', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    process.env.AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK = 'top-secret';
    try {
      await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    } finally {
      delete process.env.AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK;
    }

    expect(fake.envs).toHaveLength(1);
    expect(fake.envs[0]).not.toHaveProperty('AGENTDECK_TEST_SECRET_SHOULD_NOT_LEAK');
    expect(Object.keys(fake.envs[0]!).every((key) => profile.environmentAllowlist.includes(key))).toBe(true);
  });

  it('sends the objective and acceptance criteria as the turn prompt, and starts the thread inside the worktree', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    const threadStart = fake.writes.map((line) => JSON.parse(line)).find((message) => message.method === 'thread/start');
    expect(threadStart.params).toMatchObject({ cwd: context.worktreePath, runtimeWorkspaceRoots: [context.worktreePath] });
    const sendMessage = fake.writes.map((line) => JSON.parse(line)).find((message) => message.method === 'thread/sendMessage');
    expect(sendMessage.params.text).toContain(context.objective);
    expect(sendMessage.params.text).toContain(context.acceptanceCriteria[0]);
  });
});
