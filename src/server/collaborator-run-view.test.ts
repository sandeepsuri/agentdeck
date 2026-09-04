// The narrowing itself, unit-tested against hand-built WorkRun fixtures.
// Whether a Collaborator reaches these routes at all is app.test.ts's job,
// and which Runs they see is work-routes.test.ts's; this file only asks
// "given a Run, what actually crosses out."
import { describe, expect, it } from 'vitest';
import {
  collaboratorRunDetail, collaboratorRunSummary, relativizePaths,
} from './collaborator-run-view.js';
import type { AttemptEvent, WorkRun, WorkSpec } from '../work-engine/types.js';

const REPO_PATH = '/Users/operator/code/example';
const WORKTREE = '/Users/operator/.agentdeck/runs/run-1';

const spec: WorkSpec = {
  objective: 'Add the missing test',
  acceptanceCriteria: ['The test exists', 'The test passes'],
  repository: { id: 'repo-1', name: 'example', path: REPO_PATH },
  requestedBaseReference: 'main',
  runtimePreference: ['codex'],
  budget: { maxWallClockMs: 60_000, maxCostUsd: 5 },
  verificationIntent: { required: false, commands: [] },
  requestedDeliveryResult: 'local-commit',
  profileId: 'profile-1',
};

function baseRun(overrides: Partial<WorkRun> = {}): WorkRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: 'queued',
    spec,
    submittedAt: '2026-09-01T00:00:00.000Z',
    principal: { id: 'collab-1', displayName: 'Alice' },
    preparation: { state: 'pending' },
    envelope: { state: 'pending' },
    verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
    ...overrides,
  };
}

function completed(events: readonly AttemptEvent[], overrides: Partial<WorkRun> = {}): WorkRun {
  return baseRun({
    status: 'completed',
    preparation: { state: 'ready', worktreePath: WORKTREE, branch: 'agentdeck/run/1', baseCommit: 'abc123', targetBranch: 'main' },
    envelope: {
      state: 'ready',
      capabilityEnvelope: {
        runtime: 'codex',
        profile: {
          writableWorktree: WORKTREE, readableRoots: [REPO_PATH, '/Users/operator/.cache'],
          allowedNetworkDomains: [], environmentAllowlist: ['PATH', 'HOME'], processCeiling: 1, childRunCeiling: 0,
        },
        secretGrants: [{ name: 'GH_TOKEN', reference: 'keychain://agentdeck/gh' }],
      },
    },
    verificationPolicy: { state: 'ready', requiredGates: [{ name: 'tests', command: 'npm test -- --run' }] },
    attempt: {
      state: 'completed', runtime: 'codex', startedAt: '2026-09-01T00:01:00.000Z',
      completedAt: '2026-09-01T00:05:00.000Z', events,
    },
    ...overrides,
  });
}

describe('relativizePaths', () => {
  it('rewrites the longest known root first, so a worktree nested under the Repository is not half-rewritten', () => {
    const nested = `${REPO_PATH}/.worktrees/run-1`;
    expect(relativizePaths(`edited ${nested}/src/a.ts`, [REPO_PATH, nested])).toBe('edited ./src/a.ts');
  });

  it('masks an absolute path that was never a known root', () => {
    expect(relativizePaths('spawned /Users/operator/.nvm/versions/node/bin/node', [REPO_PATH]))
      .toBe('spawned …');
  });

  it('leaves text with no paths untouched', () => {
    expect(relativizePaths('The test suite is green.', [REPO_PATH])).toBe('The test suite is green.');
  });
});

describe('collaboratorRunSummary', () => {
  it('carries the Repository id and name but never its path', () => {
    const summary = collaboratorRunSummary(baseRun());
    expect(summary.repository).toEqual({ id: 'repo-1', name: 'example' });
    expect(JSON.stringify(summary)).not.toContain(REPO_PATH);
  });

  it('reports who requested the Run by display name only, never the Principal id', () => {
    const summary = collaboratorRunSummary(baseRun());
    expect(summary.requestedBy).toBe('Alice');
    expect(JSON.stringify(summary)).not.toContain('collab-1');
  });

  it('re-authors a missing-verification-policy preparation failure into a note addressed to the Collaborator, never the admin instruction the engine wrote', () => {
    const run = baseRun({
      preparation: {
        state: 'failed',
        error: 'No verification policy is configured for this Repository. Configure required gates or explicitly allow unverified work before starting the Run.',
      },
    });
    const summary = collaboratorRunSummary(run);
    expect(summary.preparation.state).toBe('failed');
    expect(summary.preparation.note).toBe('This Repository has no verification policy configured yet, so work cannot start. Ask the admin to set one up.');
    expect(JSON.stringify(summary)).not.toContain('Configure required gates');
  });

  it('gives every other preparation failure a generic note, never the raw error, which carries worktree paths', () => {
    const run = baseRun({
      preparation: { state: 'failed', error: `fatal: could not create work tree dir '${WORKTREE}'` },
    });
    expect(collaboratorRunSummary(run).preparation.note)
      .toBe('AgentDeck could not prepare a workspace for this Run. Ask the admin to check it.');
    expect(JSON.stringify(collaboratorRunSummary(run))).not.toContain(WORKTREE);
  });
});

describe('collaboratorRunDetail', () => {
  const events: readonly AttemptEvent[] = [
    { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:01:00.000Z', phase: 'attempt-started' },
    {
      kind: 'tool-activity', sequence: 1, at: '2026-09-01T00:01:10.000Z', tool: 'commandExecution',
      status: 'completed', summary: `/bin/zsh -lc "cat ${WORKTREE}/src/auth/session.ts"`,
    },
    {
      kind: 'verification-check', sequence: 2, at: '2026-09-01T00:03:00.000Z', gate: 'tests',
      command: 'npm test -- --run', required: true, passed: true, exitCode: 0,
      evidence: 'PASS src/auth/session.test.ts (12 tests)',
    },
    { kind: 'verification-outcome', sequence: 3, at: '2026-09-01T00:03:30.000Z', outcome: 'verified', repairAttempts: 0 },
    {
      kind: 'commit-created', sequence: 4, at: '2026-09-01T00:04:00.000Z', sha: 'deadbeefcafe',
      branch: 'agentdeck/run/1', signed: false, changedFiles: ['src/auth/session.ts'],
    },
    { kind: 'message', sequence: 5, at: '2026-09-01T00:04:30.000Z', role: 'assistant', text: `Added the missing test in ${WORKTREE}/src/auth/session.test.ts.` },
    { kind: 'completion', sequence: 6, at: '2026-09-01T00:05:00.000Z', outcome: 'success', summary: 'Done.' },
  ];

  it('narrates the Attempt without shipping a single raw command', () => {
    const detail = collaboratorRunDetail(completed(events));
    const serialized = JSON.stringify(detail);
    expect(detail.narrative.steps.length).toBeGreaterThan(0);
    expect(serialized).not.toContain('/bin/zsh');
    expect(serialized).not.toContain('npm test');
  });

  it('drops the Repository path, the worktree path, the Capability envelope and the frozen gate commands entirely', () => {
    const serialized = JSON.stringify(collaboratorRunDetail(completed(events)));
    expect(serialized).not.toContain(REPO_PATH);
    expect(serialized).not.toContain(WORKTREE);
    expect(serialized).not.toContain('keychain://agentdeck/gh');
    expect(serialized).not.toContain('environmentAllowlist');
    expect(serialized).not.toContain('readableRoots');
  });

  it('keeps a gate verdict by name, without its command or its raw output', () => {
    const { result } = collaboratorRunDetail(completed(events));
    expect(result?.verification).toEqual([{ gate: 'tests', required: true, passed: true }]);
    expect(JSON.stringify(result)).not.toContain('PASS src/auth/session.test.ts');
  });

  it('relativizes a worktree path the runtime itself wrote into its answer', () => {
    const { narrative } = collaboratorRunDetail(completed(events));
    expect(narrative.answer).toBe('Added the missing test in ./src/auth/session.test.ts.');
  });

  it('keeps the delivery commit and the repository-relative changed files', () => {
    const { result } = collaboratorRunDetail(completed(events));
    expect(result?.commit).toEqual({ sha: 'deadbeefcafe', branch: 'agentdeck/run/1', signed: false });
    expect(result?.changedFiles).toEqual(['src/auth/session.ts']);
  });

  it('drops the budget and any publication — admin configuration and an admin-only action a Collaborator should not learn exists', () => {
    const run = completed(events, {
      publication: {
        id: 'pub-1', runId: 'run-1', target: 'push', state: 'succeeded',
        idempotencyKey: 'run:run-1:commit:deadbeefcafe',
        commit: 'deadbeefcafe', branch: 'agentdeck/run/1',
        authorizedBy: { id: 'local:operator', displayName: 'operator' },
        authorizedAt: '2026-09-01T00:06:00.000Z',
        updatedAt: '2026-09-01T00:06:30.000Z', executions: 1,
      },
    });
    const serialized = JSON.stringify(collaboratorRunDetail(run));
    expect(serialized).not.toContain('maxCostUsd');
    expect(serialized).not.toContain('publication');
    expect(serialized).not.toContain('pub-1');
  });

  it('has no narrative and no result for a Run whose Attempt has not started', () => {
    const detail = collaboratorRunDetail(baseRun());
    expect(detail.narrative.steps).toEqual([]);
    expect(detail.result).toBeUndefined();
  });
});
