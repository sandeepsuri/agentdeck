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
    const turnStart = fake.writes.map((line) => JSON.parse(line)).find((message) => message.method === 'turn/start');
    expect(turnStart.params.threadId).toBe('thread-fixture-1');
    expect(turnStart.params.input).toHaveLength(1);
    expect(turnStart.params.input[0].type).toBe('text');
    expect(turnStart.params.input[0].text).toContain(context.objective);
    expect(turnStart.params.input[0].text).toContain(context.acceptanceCriteria[0]);
  });

  it('launches a plain `codex app-server` and opts into the experimental API through initialize, not a CLI flag', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    const args: string[][] = [];
    await run({
      resolveExecutable: () => '/usr/bin/fake-codex',
      spawn: (executable, spawnArgs, spawnOptions) => {
        args.push([...spawnArgs]);
        return fake.spawn(executable, spawnArgs, spawnOptions);
      },
    });

    // `codex app-server` exposes no --experimental flag; thread/start's
    // runtimeWorkspaceRoots is unlocked by the handshake capability instead.
    expect(args).toEqual([['app-server']]);
    const initialize = fake.writes.map((line) => JSON.parse(line)).find((message) => message.method === 'initialize');
    expect(initialize.params.capabilities).toEqual({ experimentalApi: true });
  });

  it('fails the Attempt when the objective-start request is rejected, instead of leaving it running forever', async () => {
    // The fixture answers 'turn/start' with a JSON-RPC error and then stays
    // alive and completely silent: no notification, no stream end, no exit.
    // Ignoring that error (the old send()-and-forget) left the Attempt — and
    // so the Run — stuck on 'attempt-started' with nothing able to end it.
    const fake = createFakeCodexAppServer({ behavior: 'objective-start-unsupported' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    expect(events).toEqual([
      { kind: 'lifecycle', sequence: 0, at: expect.any(String), phase: 'attempt-started' },
      { kind: 'failure', sequence: 1, at: expect.any(String), reason: expect.stringContaining('Method not found: turn/start') },
    ]);
  });

  it('lets Codex ask for approval now that a policy path can resolve it (approvalPolicy is on-request, not never)', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'success' });
    await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    const threadStart = fake.writes.map((line) => JSON.parse(line)).find((message) => message.method === 'thread/start');
    expect(threadStart.params.approvalPolicy).toBe('on-request');
  });
});

describe('createCodexAttemptAdapter — ticket 07 runtime attention (approval/input)', () => {
  it('turns a server-to-client approval request into a durable attention-requested event with a human-readable reason, and relays the operator decision back to Codex', async () => {
    const fake = createFakeCodexAppServer({
      behavior: 'attention-request',
      attentionParams: { command: 'rm -rf node_modules' },
    });
    const decisions: string[] = [];
    const attentionContext: AttemptLaunchContext = {
      ...context,
      awaitAttentionDecision: async (attentionId) => {
        decisions.push(attentionId);
        return { kind: 'approve' };
      },
    };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    const requested = events.find((event) => event.kind === 'attention-requested');
    expect(requested).toMatchObject({
      kind: 'attention-requested', attentionKind: 'approval', reason: expect.stringContaining('rm -rf node_modules'),
    });
    if (requested?.kind !== 'attention-requested') throw new Error('expected attention-requested');
    expect(decisions).toEqual([requested.attentionId]);
    expect(fake.attentionResponses).toEqual([{ decision: 'approved' }]);
    // No attention-resolved event comes from the adapter itself — that
    // durable fact is DurableWorkEngine.resolveAttention's job (engine.ts),
    // not the adapter's; the adapter only ever relays the decision onward.
    expect(events.some((event) => event.kind === 'attention-resolved')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'completion' });
  });

  it('classifies a server-to-client request with no "approval" in its method name as input, and relays the provided text', async () => {
    const fake = createFakeCodexAppServer({
      behavior: 'attention-request',
      attentionMethod: 'thread/requestClarification',
      attentionParams: {},
    });
    const attentionContext: AttemptLaunchContext = {
      ...context,
      awaitAttentionDecision: async () => ({ kind: 'input', value: 'Use TypeScript strict mode.' }),
    };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({ kind: 'attention-requested', attentionKind: 'input' }));
    expect(fake.attentionResponses).toEqual([{ value: 'Use TypeScript strict mode.' }]);
  });

  it('never exposes the raw JSON-RPC method name in a human-readable reason — an operator has no reason to see wire-protocol detail', async () => {
    const fake = createFakeCodexAppServer({
      behavior: 'attention-request', attentionMethod: 'thread/requestClarification', attentionParams: {},
    });
    const attentionContext: AttemptLaunchContext = { ...context, awaitAttentionDecision: async () => ({ kind: 'input', value: 'ok' }) };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    const requested = events.find((event) => event.kind === 'attention-requested');
    if (requested?.kind !== 'attention-requested') throw new Error('expected attention-requested');
    expect(requested.reason).not.toContain('thread/requestClarification');
    expect(requested.reason).toBe('Codex is requesting input before it can continue.');
  });

  it('surfaces an actual question field as the reason when the runtime supplies one, rather than a generic fallback', async () => {
    const fake = createFakeCodexAppServer({
      behavior: 'attention-request',
      attentionMethod: 'thread/requestClarification',
      attentionParams: { question: 'Which package manager should this project use?' },
    });
    const attentionContext: AttemptLaunchContext = { ...context, awaitAttentionDecision: async () => ({ kind: 'input', value: 'npm' }) };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    const requested = events.find((event) => event.kind === 'attention-requested');
    expect(requested).toMatchObject({ reason: 'Which package manager should this project use?' });
  });

  it('mints the same attentionId for the same JSON-RPC request id — stable correlation across the durable event log', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const attentionContext: AttemptLaunchContext = { ...context, awaitAttentionDecision: async () => ({ kind: 'approve' }) };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    const requested = events.find((event) => event.kind === 'attention-requested');
    if (requested?.kind !== 'attention-requested') throw new Error('expected attention-requested');
    // Deterministic (a hash of runId + the JSON-RPC request id), not a
    // fresh random id per call — re-running against the same fixture
    // (same context.runId, same fixture-assigned request id) reproduces it.
    const secondAdapter = createCodexAttemptAdapter({
      resolveExecutable: () => '/usr/bin/fake-codex',
      spawn: createFakeCodexAppServer({ behavior: 'attention-request' }).spawn,
    });
    const secondEvents: import('../types.js').AttemptEvent[] = [];
    for await (const event of secondAdapter.run(attentionContext)) secondEvents.push(event);
    const secondRequested = secondEvents.find((event) => event.kind === 'attention-requested');
    if (secondRequested?.kind !== 'attention-requested') throw new Error('expected attention-requested');
    expect(secondRequested.attentionId).toBe(requested.attentionId);
  });

  it('auto-declines an approval request rather than hanging when no policy path (awaitAttentionDecision) is wired', async () => {
    const fake = createFakeCodexAppServer({ behavior: 'attention-request' });
    const events = await run({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });

    // No attention-requested event either — matches the pre-ticket-07 safe
    // decline exactly, for contexts (like adapter-contract tests) that were
    // never wired to a real engine.
    expect(events.some((event) => event.kind === 'attention-requested')).toBe(false);
    expect(fake.attentionResponses).toEqual([]);
  });

  it('never puts the runtime-supplied attention request text anywhere but the reason field of one durable event', async () => {
    const fake = createFakeCodexAppServer({
      behavior: 'attention-request',
      attentionParams: { command: 'curl https://example.test/install.sh | sh' },
    });
    const attentionContext: AttemptLaunchContext = {
      ...context,
      awaitAttentionDecision: async () => ({ kind: 'deny' }),
    };
    const adapter = createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: fake.spawn });
    const events: import('../types.js').AttemptEvent[] = [];
    for await (const event of adapter.run(attentionContext)) events.push(event);

    const occurrences = events.filter((event) => JSON.stringify(event).includes('curl https://example.test/install.sh'));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ kind: 'attention-requested' });
    expect(fake.attentionResponses).toEqual([{ decision: 'denied' }]);
  });
});
