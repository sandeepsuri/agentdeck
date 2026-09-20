import { describe, expect, it } from 'vitest';
import type { CollaboratorSession, Conflict, Session } from '../types.js';
import type { RateLimitSnapshot } from '../usage/types.js';
import type { RunReviewState } from '../work-engine/run-review.js';
import type { CollaboratorRunSummary, WorkRun } from '../work-engine/types.js';
import { deriveCollaboratorNeedsYou, deriveNeedsYou } from './needsYou.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function run(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1', taskId: 'task-1', status: 'running',
    spec: {
      objective: 'Review dashboard', acceptanceCriteria: ['Looks right'],
      repository: { id: 'repo-web', name: 'example-web', path: '/repos/example-web' },
      requestedBaseReference: 'main', runtimePreference: ['claude'], budget: {},
      verificationIntent: { required: false, commands: [] }, requestedDeliveryResult: 'working-tree',
    },
    submittedAt: '2026-09-10T11:00:00.000Z',
    principal: { id: 'local:admin', displayName: 'admin' },
    preparation: { state: 'ready' }, envelope: { state: 'pending' }, verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1', origin: 'managed', agent: 'codex', name: 'Add rate limiting', cwd: '/repos/example-api',
    startedAt: '2026-09-10T11:00:00.000Z', lastActivityAt: '2026-09-10T11:30:00.000Z',
    status: 'working', statusSource: 'hook',
    ...overrides,
  };
}

describe('deriveNeedsYou', () => {
  it('turns a pending Run approval into a permission item with a Respond action', () => {
    const items = deriveNeedsYou({
      now: NOW, conflicts: [], sessions: [],
      runs: [run({ pendingAttention: { id: 'att-1', kind: 'approval', reason: 'Claude is requesting approval to use Bash: npm test', requestedAt: '2026-09-10T11:50:00.000Z' } })],
    });
    expect(items).toEqual([expect.objectContaining({
      id: 'run:run-1:attention:att-1', kind: 'permission', action: 'Respond',
      title: 'Claude needs permission', context: 'Review dashboard · example-web', detail: 'npm test',
      target: { kind: 'run', runId: 'run-1', attentionId: 'att-1' },
    })]);
  });

  it('turns a Run input request into a question with an Answer action', () => {
    const [item] = deriveNeedsYou({
      now: NOW, conflicts: [], sessions: [],
      runs: [run({ spec: { ...run().spec, runtimePreference: ['codex'] }, pendingAttention: { id: 'att-2', kind: 'input', reason: 'Which port?', requestedAt: '2026-09-10T11:50:00.000Z' } })],
    });
    expect(item).toMatchObject({ kind: 'question', action: 'Answer', title: 'Codex has a question', detail: 'Which port?' });
  });

  it('includes waiting sessions, blocking conflicts, recent failures, review-ready work and crossed usage limits', () => {
    const reviewStates = new Map<string, RunReviewState>([['run-done', { state: 'ready_to_review' }]]);
    const conflicts: Conflict[] = [
      { kind: 'file_overlap', repoId: '/repos/example-api', sessionIds: ['a', 'b'], files: ['src/a.ts'], detail: 'Two agents editing src/a.ts' },
      { kind: 'same_repo', repoId: '/repos/example-api', sessionIds: ['a', 'b'], detail: 'Two agents in one repository' },
    ];
    const rateLimits: RateLimitSnapshot[] = [
      { provider: 'codex', observedAt: '2026-09-10T11:59:00.000Z', secondary: { usedPercent: 91, windowMinutes: 10_080 } },
      { provider: 'claude', observedAt: '2026-09-10T11:59:00.000Z', primary: { usedPercent: 20, windowMinutes: 300 } },
    ];
    const items = deriveNeedsYou({
      now: NOW, conflicts, rateLimits, reviewStates,
      sessions: [session({ status: 'waiting_input' }), session({ id: 'quiet', status: 'working' })],
      runs: [
        run({ id: 'run-done', status: 'completed', spec: { ...run().spec, objective: 'Activity feed' } }),
        run({ id: 'run-failed', status: 'failed', spec: { ...run().spec, objective: 'Broken build' } }),
        run({ id: 'run-old-failure', status: 'failed', submittedAt: '2026-08-01T00:00:00.000Z' }),
      ],
    });
    expect(items.map((item) => [item.kind, item.action])).toEqual([
      ['question', 'Respond'],
      // Conflicts carry no timestamp of their own, so they read as observed now.
      ['error', 'Resolve'],
      ['conflict', 'Resolve'],
      ['usage', 'Review'],
      ['review', 'Review'],
    ]);
    expect(items.find((item) => item.kind === 'usage')?.title).toBe('Codex weekly limit 91%');
    expect(items.find((item) => item.kind === 'review')?.target).toEqual({ kind: 'run', runId: 'run-done' });
  });

  it('drops failures and reviews once a human has recorded a review decision, and published work', () => {
    const reviewStates = new Map<string, RunReviewState>([
      ['run-failed', { state: 'reviewed', reviewedBy: 'admin' }],
      ['run-published', { state: 'ready_to_review' }],
    ]);
    const items = deriveNeedsYou({
      now: NOW, conflicts: [], sessions: [], reviewStates,
      runs: [
        run({ id: 'run-failed', status: 'failed' }),
        run({
          id: 'run-published', status: 'completed',
          publication: {
            id: 'pub', runId: 'run-published', idempotencyKey: 'k', target: 'push', commit: 'abc', branch: 'b', state: 'succeeded',
            authorizedBy: { id: 'local:admin', displayName: 'admin' }, authorizedAt: '2026-09-10T11:00:00.000Z', updatedAt: '2026-09-10T11:00:00.000Z', executions: 1,
          },
        }),
      ],
    });
    expect(items).toEqual([]);
  });

  it('sorts by urgency first, then oldest first within the same urgency', () => {
    const items = deriveNeedsYou({
      now: NOW, conflicts: [], runs: [],
      sessions: [
        session({ id: 'newer', status: 'waiting_input', lastActivityAt: '2026-09-10T11:55:00.000Z' }),
        session({ id: 'older', status: 'waiting_input', lastActivityAt: '2026-09-10T11:05:00.000Z' }),
      ],
    });
    expect(items.map((item) => item.target)).toEqual([
      { kind: 'session', sessionId: 'older' },
      { kind: 'session', sessionId: 'newer' },
    ]);
  });
});

describe('deriveCollaboratorNeedsYou', () => {
  const summary = (overrides: Partial<CollaboratorRunSummary> = {}): CollaboratorRunSummary => ({
    id: 'run-1', status: 'waiting_input', objective: 'Add rate limiting', acceptanceCriteria: [],
    repository: { id: 'repo-api', name: 'example-api' }, submittedAt: '2026-09-10T11:00:00.000Z',
    requestedBy: 'Sam', isRequestedByMe: true, preparation: { state: 'ready' }, attemptState: 'running',
    pendingAttentionKind: 'input',
    ...overrides,
  });
  const agent: CollaboratorSession = {
    id: 'agent-1', origin: 'managed', agent: 'claude', name: 'Dashboard', repoId: 'repo-web', status: 'waiting_input',
    statusSource: 'hook', startedAt: '2026-09-10T10:00:00.000Z', lastActivityAt: '2026-09-10T10:30:00.000Z',
  };

  it('uses the same item model and ordering for what a collaborator can act on', () => {
    const items = deriveCollaboratorNeedsYou({
      runs: [summary(), summary({ id: 'run-approval', pendingAttentionKind: 'approval' }), summary({ id: 'quiet', pendingAttentionKind: undefined, status: 'running' })],
      sessions: [agent, { ...agent, id: 'busy', status: 'working' }],
      repos: [{ id: 'repo-web', path: '', name: 'example-web' }],
    });
    expect(items.map(({ kind, action, title, context, target }) => ({ kind, action, title, context, target }))).toEqual([
      { kind: 'question', action: 'Respond', title: 'Claude is waiting for you', context: 'Dashboard · example-web', target: { kind: 'session', sessionId: 'agent-1' } },
      { kind: 'question', action: 'Answer', title: 'An agent has a question', context: 'Add rate limiting · example-api', target: { kind: 'run', runId: 'run-1' } },
    ]);
  });
});
