import { describe, expect, it } from 'vitest';
import type { Repo, Session } from '../types.js';
import type { RunReviewState } from '../work-engine/run-review.js';
import type { WorkRun } from '../work-engine/types.js';
import { deriveNeedsYou } from './needsYou.js';
import { countWorkBuckets, deriveWorkItems, filterWorkItems } from './workItems.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const repos: Repo[] = [
  { id: 'repo-web', path: '/repos/example-web', name: 'example-web', currentBranch: 'main' },
  { id: 'repo-api', path: '/repos/example-api', name: 'example-api', currentBranch: 'main' },
];

function run(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1', taskId: 'task-1', status: 'running',
    spec: {
      objective: 'Build activity feed', acceptanceCriteria: ['Feed renders'],
      repository: { id: 'repo-web', name: 'example-web', path: '/repos/example-web' },
      requestedBaseReference: 'main', runtimePreference: ['codex'], budget: {},
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
    id: 'session-1', origin: 'managed', agent: 'claude', name: 'Review dashboard', cwd: '/repos/example-api',
    repoId: 'repo-api', startedAt: '2026-09-10T11:00:00.000Z', lastActivityAt: '2026-09-10T11:30:00.000Z',
    status: 'working', statusSource: 'hook', pid: 4711, tty: 'ttys004',
    ...overrides,
  };
}

function derive(input: { runs?: WorkRun[]; sessions?: Session[]; historySessions?: Session[]; reviewStates?: Map<string, RunReviewState> }) {
  const runs = input.runs ?? [];
  const sessions = input.sessions ?? [];
  const needsYou = deriveNeedsYou({ runs, sessions, conflicts: [], reviewStates: input.reviewStates, now: NOW });
  return deriveWorkItems({ runs, sessions, historySessions: input.historySessions ?? [], repos, needsYou, reviewStates: input.reviewStates, now: NOW });
}

describe('deriveWorkItems', () => {
  it('presents Runs and Sessions as one kind of work with title, agent, repository and status', () => {
    const items = derive({ runs: [run()], sessions: [session()] });
    expect(items.map(({ id, kind, title, agentLabel, repositoryId, repositoryName, bucket, statusLabel }) => ({ id, kind, title, agentLabel, repositoryId, repositoryName, bucket, statusLabel }))).toEqual([
      { id: 'session:session-1', kind: 'session', title: 'Review dashboard', agentLabel: 'Claude', repositoryId: 'repo-api', repositoryName: 'example-api', bucket: 'working', statusLabel: 'Working' },
      { id: 'run:run-1', kind: 'run', title: 'Build activity feed', agentLabel: 'Codex', repositoryId: 'repo-web', repositoryName: 'example-web', bucket: 'working', statusLabel: 'Working' },
    ]);
  });

  it('places work in the bucket the global Needs You queue, review state and lifecycle imply', () => {
    const reviewStates = new Map<string, RunReviewState>([
      ['run-review', { state: 'ready_to_review' }],
      ['run-reviewed', { state: 'reviewed', reviewedBy: 'admin' }],
    ]);
    const items = derive({
      reviewStates,
      runs: [
        run({ id: 'run-waiting', status: 'waiting_approval', pendingAttention: { id: 'a', kind: 'approval', reason: 'x', requestedAt: '2026-09-10T11:40:00.000Z' } }),
        run({ id: 'run-review', status: 'completed' }),
        run({ id: 'run-reviewed', status: 'completed' }),
        run({ id: 'run-ancient', status: 'cancelled', submittedAt: '2026-07-01T00:00:00.000Z' }),
      ],
      sessions: [session({ id: 'waiting', status: 'waiting_input' }), session({ id: 'ended', status: 'exited', endedAt: '2026-09-10T11:50:00.000Z' })],
      historySessions: [session({ id: 'history', status: 'exited', endedAt: '2026-09-09T00:00:00.000Z' })],
    });
    const byId = Object.fromEntries(items.map((item) => [item.id, [item.bucket, item.statusLabel]]));
    expect(byId).toEqual({
      'run:run-waiting': ['needs_you', 'Waiting for approval'],
      'session:waiting': ['needs_you', 'Waiting'],
      'run:run-review': ['review', 'Ready for review'],
      'run:run-reviewed': ['completed', 'Reviewed'],
      'session:ended': ['completed', 'Exited'],
      'run:run-ancient': ['archived', 'Cancelled'],
      'session:history': ['archived', 'Exited'],
    });
    expect(items.slice(0, 2).every((item) => item.bucket === 'needs_you')).toBe(true);
  });

  it('never exposes process identity in the default fields', () => {
    const [item] = derive({ sessions: [session()] });
    expect(JSON.stringify({ title: item!.title, statusLabel: item!.statusLabel, repositoryName: item!.repositoryName })).not.toMatch(/4711|ttys004/);
  });
});

describe('filterWorkItems and countWorkBuckets', () => {
  const items = derive({
    runs: [run(), run({ id: 'run-2', status: 'completed', spec: { ...run().spec, objective: 'Update API route', repository: { id: 'repo-api', name: 'example-api', path: '/repos/example-api' } } })],
    sessions: [session(), session({ id: 'session-2', agent: 'codex', name: 'Codex helper', status: 'waiting_input' })],
  });

  it('filters by status bucket, repository, agent and free text together', () => {
    expect(filterWorkItems(items, { status: 'working' }).map((item) => item.id)).toEqual(['session:session-1', 'run:run-1']);
    expect(filterWorkItems(items, { status: 'all', repositoryId: 'repo-api' }).map((item) => item.id)).toEqual(['session:session-2', 'session:session-1', 'run:run-2']);
    expect(filterWorkItems(items, { status: 'all', agent: 'codex', repositoryId: 'repo-api' }).map((item) => item.id)).toEqual(['session:session-2', 'run:run-2']);
    expect(filterWorkItems(items, { status: 'all', query: 'api route' }).map((item) => item.id)).toEqual(['run:run-2']);
  });

  it('counts each bucket for the filter chips', () => {
    expect(countWorkBuckets(items)).toEqual({ all: 4, needs_you: 1, working: 2, review: 0, completed: 1, archived: 0 });
  });
});
