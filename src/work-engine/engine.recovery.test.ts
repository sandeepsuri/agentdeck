// Ticket 06 AC9: crash-injection coverage for DurableWorkEngine.recover.
// Each "crash" is simulated by constructing the durable state a real crash
// would leave behind (directly via Store, or by abandoning a live Attempt
// mid-flight) and then pointing a *fresh* engine instance — standing in for
// the restarted process — at the same store.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  afterEach, describe, expect, it,
} from 'vitest';
import { runtimeReadinessReportFixture, stubRuntimeReadinessSource } from '../test-fixtures/runtime-readiness.js';
import { Store } from '../store/index.js';
import { buildAttemptEventEnvelope } from './durable-events.js';
import { DurableWorkEngine } from './engine.js';
import { isContinuationSupported } from './recovery.js';
import type { CodexAttemptProcess, CodexProcessSpawner } from './runtimes/codex.js';
import { createCodexAttemptAdapter } from './runtimes/codex.js';
import type { AttemptEvent, RunRepository, WorkSpec } from './types.js';

const tempDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-recovery-'));
  tempDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'agentdeck@example.test');
  git(dir, 'config', 'user.name', 'AgentDeck Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
  git(dir, 'branch', '-M', 'main');
}

function workSpec(repository: RunRepository): WorkSpec {
  return {
    objective: 'Add durable managed work',
    acceptanceCriteria: ['The interrupted run is never left stuck'],
    repository,
    requestedBaseReference: 'main',
    runtimePreference: ['codex'],
    budget: { maxWallClockMs: 3_600_000 },
    verificationIntent: { required: false, commands: [] },
    requestedDeliveryResult: 'working-tree',
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A `codex app-server` double that completes the handshake and then goes silent — standing in for a process whose host crashed mid-turn. */
function silentAfterHandshakeSpawn(): CodexProcessSpawner {
  return (_executable, _args, _options) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {
      // Never resolves — no process-exit notification ever arrives, exactly
      // like a hard-killed process with no chance to signal its parent.
    });
    let buffer = '';
    stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-crash-1' } } })}\n`);
        } else if (message.method === 'turn/start') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/started',
            params: { threadId: 'thread-crash-1', item: { id: 'item-1', type: 'command_execution', command: 'npm test' } },
          })}\n`);
          // ...and then nothing more, ever: no item/completed, no
          // turn/completed, no process exit.
        }
      }
    });
    return {
      stdin, stdout, stderr, exited, kill: () => { stdout.end(); },
    } satisfies CodexAttemptProcess;
  };
}

function setUp() {
  const root = tempDir();
  const repoPath = path.join(root, 'repo');
  initGitRepo(repoPath);
  const store = new Store(':memory:');
  const repository: RunRepository = { id: repoPath, name: 'example', path: repoPath };
  store.upsertRepo(repository);
  const runsRoot = path.join(root, 'runs');
  return {
    store, repository, runsRoot,
  };
}

describe('DurableWorkEngine.recover — crash before Attempt start', () => {
  it('leaves an idle Attempt untouched and still startable', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const submitted = await engine.submit(workSpec(repository));
    const prepared = await engine.prepare(submitted.id);
    expect(prepared.attempt.state).toBe('idle');

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    expect(restarted.get(submitted.id)?.attempt.state).toBe('idle');
    expect(restarted.get(submitted.id)?.status).toBe('preparing');
  });

  it('leaves a merely-queued (never prepared) Run untouched', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const submitted = await engine.submit(workSpec(repository));

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    expect(restarted.get(submitted.id)).toEqual(submitted);
  });
});

describe('DurableWorkEngine.recover — crash after Attempt start, before any event', () => {
  it('ends the Attempt with a precise unrecoverable reason and no ambiguous-activity note', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    // Simulate the crash landing between engine.start()'s startAttempt()
    // call and the adapter producing its first event.
    store.startAttempt({
      id: 'attempt-crash-1', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(store.getRun(prepared.id)?.attempt.state).toBe('running');

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    const recovered = restarted.get(prepared.id)!;
    expect(recovered.status).toBe('failed');
    expect(recovered.attempt.state).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    expect(recovered.attempt.reason).toContain('AgentDeck restarted before this Attempt finished');
    expect(recovered.attempt.reason).not.toContain('never reported completion or failure');
    expect(recovered.attempt.events.map((event) => event.kind)).toEqual(['failure']);
  });
});

describe('DurableWorkEngine.recover — crash mid-Attempt, after durable events were persisted', () => {
  function appendEvent(store: Store, runId: string, attemptId: string, event: AttemptEvent): void {
    store.appendAttemptEvent(buildAttemptEventEnvelope({ runId, attemptId, event }));
  }

  it('preserves every already-durable event and marks the in-flight tool activity ambiguous, never assuming it finished', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    store.startAttempt({
      id: 'attempt-crash-2', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });
    appendEvent(store, prepared.id, 'attempt-crash-2', {
      kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started',
    });
    appendEvent(store, prepared.id, 'attempt-crash-2', {
      kind: 'tool-activity', sequence: 1, at: '2026-09-01T00:00:02.000Z', tool: 'command_execution', status: 'started', summary: 'npm test',
    });

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    const recovered = restarted.get(prepared.id)!;
    expect(recovered.attempt.state).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    // The two prior durable events are untouched — never rewritten to a
    // guessed outcome.
    expect(recovered.attempt.events[0]).toMatchObject({ kind: 'lifecycle', phase: 'attempt-started' });
    expect(recovered.attempt.events[1]).toMatchObject({ kind: 'tool-activity', status: 'started', tool: 'command_execution' });
    expect(recovered.attempt.events).toHaveLength(3);
    expect(recovered.attempt.reason).toContain('command_execution: npm test');
    expect(recovered.attempt.reason).toContain('its outcome is unknown and was not assumed');
  });

  it('states plainly when the installed runtime does support continuation, but still never resumes it', async () => {
    const { store, repository, runsRoot } = setUp();
    // The default fixture already reports codex continuation: true — this
    // is the case where the CLI *could* resume a conversation, but
    // AgentDeck never persisted what it would need to do so safely.
    expect(isContinuationSupported(runtimeReadinessReportFixture, 'codex')).toBe(true);
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    store.startAttempt({
      id: 'attempt-crash-3', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });
    appendEvent(store, prepared.id, 'attempt-crash-3', {
      kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started',
    });

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    const recovered = restarted.get(prepared.id)!;
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    expect(recovered.attempt.reason).toContain('reports structured continuation support');
    expect(recovered.attempt.reason).toContain('never persists what a runtime needs to resume');
  });
});

describe('DurableWorkEngine.recover — crash exactly at completion, before verification (ticket 08)', () => {
  it('ends the Attempt as failed rather than silently accepting an unverified outcome', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    store.startAttempt({
      id: 'attempt-crash-4', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: prepared.id,
      attemptId: 'attempt-crash-4',
      event: {
        kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started',
      },
    }));
    store.appendAttemptEvent(buildAttemptEventEnvelope({
      runId: prepared.id,
      attemptId: 'attempt-crash-4',
      event: {
        kind: 'completion', sequence: 1, at: '2026-09-01T00:01:00.000Z', outcome: 'success',
      },
    }));
    // Even though the run's own status column was never separately written
    // (a real crash right after the completion event persisted, before any
    // such write), the derived projection already reads 'verifying' — the
    // runtime finished, but no verification-outcome event exists yet, so
    // this is not a real terminal outcome (ticket 08 AC8).
    expect(store.getRun(prepared.id)?.status).toBe('verifying');

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    // No live process survives the restart to run the gate commands that
    // would have concluded verification — recover() (ticket 06) treats this
    // exactly like any other Attempt abandoned mid-flight, appending one
    // terminal failure event rather than ever assuming an unverified success.
    const recovered = restarted.get(prepared.id)!;
    expect(recovered.status).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    expect(recovered.attempt.reason).toContain('AgentDeck restarted before this Attempt finished');
    expect(recovered.attempt.reason).toContain('runtime reported completion');
    expect(recovered.attempt.reason).toContain('restarted before its changes could be verified');
    expect(recovered.attempt.events).toHaveLength(3);
  });
});

describe('DurableWorkEngine.recover — crash while an approval/input request was pending (ticket 07 AC4)', () => {
  it('ends the Attempt with a precise reason describing the unresolved request, and never lets it be resolved afterward', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    store.startAttempt({
      id: 'attempt-crash-6', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });
    appendEvent(store, prepared.id, 'attempt-crash-6', {
      kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:00:01.000Z', phase: 'attempt-started',
    });
    appendEvent(store, prepared.id, 'attempt-crash-6', {
      kind: 'attention-requested',
      sequence: 1,
      at: '2026-09-01T00:00:02.000Z',
      attentionId: 'attention-1',
      attentionKind: 'approval',
      reason: 'Codex is requesting approval to run: rm -rf node_modules',
    });
    expect(store.getRun(prepared.id)?.pendingAttention).toMatchObject({ id: 'attention-1', kind: 'approval' });

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    const recovered = restarted.get(prepared.id)!;
    expect(recovered.status).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    expect(recovered.attempt.reason).toContain('AgentDeck restarted before this Attempt finished');
    expect(recovered.attempt.reason).toContain('waiting on an approval request');
    expect(recovered.attempt.reason).toContain('rm -rf node_modules');
    // The dangling request is never surfaced as pending once the Attempt has
    // a terminal outcome — AC4's "never reopening" guarantee.
    expect(recovered.pendingAttention).toBeUndefined();

    await expect(restarted.resolveAttention(prepared.id, 'attention-1', { kind: 'approve' }))
      .rejects.toThrow(/no pending attention request/);
  });

  function appendEvent(store: Store, runId: string, attemptId: string, event: AttemptEvent): void {
    store.appendAttemptEvent(buildAttemptEventEnvelope({ runId, attemptId, event }));
  }
});

describe('DurableWorkEngine.recover — reconnect idempotency', () => {
  it('running recover twice appends exactly one terminal failure event, not two', async () => {
    const { store, repository, runsRoot } = setUp();
    const engine = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    const prepared = await engine.prepare((await engine.submit(workSpec(repository))).id);
    store.startAttempt({
      id: 'attempt-crash-5', runId: prepared.id, runtime: 'codex', startedAt: '2026-09-01T00:00:00.000Z',
    });

    const first = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await first.recover();
    const afterFirst = first.get(prepared.id)!;
    if (afterFirst.attempt.state === 'idle') throw new Error('expected a started Attempt');
    expect(afterFirst.attempt.events).toHaveLength(1);

    const second = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await second.recover();
    const afterSecond = second.get(prepared.id)!;
    if (afterSecond.attempt.state === 'idle') throw new Error('expected a started Attempt');

    expect(afterSecond.attempt.events).toHaveLength(1);
    expect(afterSecond).toEqual(afterFirst);
  });
});

describe('DurableWorkEngine.recover — full integration: an abandoned live process', () => {
  it('never re-invokes the runtime and ends the Run precisely once a fresh engine recovers it', async () => {
    const { store, repository, runsRoot } = setUp();
    const abandoned = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource(), {
      codex: createCodexAttemptAdapter({ resolveExecutable: () => '/usr/bin/fake-codex', spawn: silentAfterHandshakeSpawn() }),
    });
    const prepared = await abandoned.prepare((await abandoned.submit(workSpec(repository))).id);
    const started = await abandoned.start(prepared.id);
    expect(started.status).toBe('running');
    // Give the fake process's queued item/started notification a chance to
    // reach the adapter and persist durably before the "crash".
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(store.getRun(prepared.id)?.attempt.state).toBe('running');

    const restarted = new DurableWorkEngine(store, runsRoot, stubRuntimeReadinessSource());
    await restarted.recover();

    const recovered = restarted.get(prepared.id)!;
    expect(recovered.status).toBe('failed');
    if (recovered.attempt.state !== 'failed') throw new Error('expected failed');
    expect(recovered.attempt.reason).toContain('AgentDeck restarted before this Attempt finished');
    // The abandoned adapter's own dangling iterator never gets to append a
    // real terminal event of its own after this — recovery's failure event
    // is final.
    const rechecked = restarted.get(prepared.id)!;
    if (rechecked.attempt.state !== 'failed') throw new Error('expected failed');
    expect(rechecked.attempt.events.at(-1)?.kind).toBe('failure');
  });
});
