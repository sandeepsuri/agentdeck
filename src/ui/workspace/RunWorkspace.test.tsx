import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkRun } from '../../work-engine/types.js';
import { RunWorkspace } from './RunWorkspace.js';

function baseRun(): WorkRun {
  return {
    id: 'run-durable-123',
    taskId: 'task-durable-123',
    status: 'queued',
    submittedAt: '2026-09-01T00:00:00.000Z',
    spec: {
      objective: 'Implement durable runs',
      acceptanceCriteria: ['Restart keeps identity'],
      repository: { id: '/repos/example', name: 'example', path: '/repos/example' },
      requestedBaseReference: 'refs/heads/main',
      runtimePreference: ['codex', 'claude'],
      budget: { maxWallClockMs: 60000, maxModelTurns: 10 },
      verificationIntent: { required: true, commands: ['npm test'] },
      requestedDeliveryResult: 'local-commit',
    },
    principal: { id: 'local:test', displayName: 'test' },
    preparation: { state: 'pending' },
    envelope: { state: 'pending' },
    verificationPolicy: { state: 'pending' },
    attempt: { state: 'idle' },
  };
}

describe('RunWorkspace', () => {
  it('reopens and displays the queued run identity and full submitted intent', () => {
    const run = baseRun();

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of [
      'Run run-durable-123', 'Queued', 'Implement durable runs', 'Restart keeps identity',
      'example', 'refs/heads/main', 'codex → claude', 'npm test', 'Local commit',
    ]) expect(html).toContain(expected);
  });

  it('shows the Repository, resolved base commit, worktree, and preparation state once prepared', () => {
    const run: WorkRun = {
      ...baseRun(),
      status: 'preparing',
      preparation: {
        state: 'ready',
        baseCommit: 'abc123def456',
        worktreePath: '/repos/example-runs/run-durable-123',
        branch: 'agentdeck/run/run-durable-123',
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of ['example', 'Ready', 'abc123def456', '/repos/example-runs/run-durable-123']) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('Prepare worktree');
  });

  it('surfaces a failed preparation state and its recoverable explanation with a retry action', () => {
    const run: WorkRun = {
      ...baseRun(),
      preparation: { state: 'failed', error: 'Worktree path already exists: /repos/example-runs/run-durable-123' },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, onPrepare: () => undefined }));

    expect(html).toContain('Failed');
    expect(html).toContain('Worktree path already exists');
    expect(html).toContain('Retry worktree preparation');
  });

  it('offers no preparation action once a worktree is already ready', () => {
    const run: WorkRun = {
      ...baseRun(),
      preparation: { state: 'ready', baseCommit: 'abc123', worktreePath: '/repos/example-runs/run-durable-123' },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, onPrepare: () => undefined }));

    expect(html).not.toContain('Prepare worktree');
    expect(html).not.toContain('Retry worktree preparation');
  });

  it('shows the effective capability envelope once frozen', () => {
    const run: WorkRun = {
      ...baseRun(),
      envelope: {
        state: 'ready',
        capabilityEnvelope: {
          runtime: 'codex',
          profile: {
            writableWorktree: '/repos/example-runs/run-durable-123',
            readableRoots: ['/repos/example-runs/run-durable-123'],
            allowedNetworkDomains: ['api.openai.com', 'chatgpt.com'],
            environmentAllowlist: ['PATH', 'HOME'],
            processCeiling: 16,
            childRunCeiling: 0,
          },
          secretGrants: [{ name: 'github-token', reference: 'secret-ref:github-token-1' }],
        },
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    for (const expected of [
      'Capability envelope', 'Codex', '/repos/example-runs/run-durable-123',
      'api.openai.com', 'chatgpt.com', 'PATH', 'HOME', '16', 'github-token', 'secret-ref:github-token-1',
    ]) expect(html).toContain(expected);
  });

  it('shows a human-readable reason when the envelope is refused', () => {
    const run: WorkRun = {
      ...baseRun(),
      envelope: {
        state: 'refused',
        reason: 'No preferred runtime can satisfy the managed capability envelope. Claude Code: '
          + 'cannot enforce the managed capability envelope (execution restrictions unsupported).',
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run }));

    expect(html).toContain('Refused');
    expect(html).toContain('execution restrictions unsupported');
  });
});

function eligibleRun(): WorkRun {
  return {
    ...baseRun(),
    preparation: { state: 'ready', baseCommit: 'abc123', worktreePath: '/repos/example-runs/run-durable-123' },
    envelope: {
      state: 'ready',
      capabilityEnvelope: {
        runtime: 'codex',
        profile: {
          writableWorktree: '/repos/example-runs/run-durable-123',
          readableRoots: ['/repos/example-runs/run-durable-123'],
          allowedNetworkDomains: ['api.openai.com', 'chatgpt.com'],
          environmentAllowlist: ['PATH', 'HOME'],
          processCeiling: 16,
          childRunCeiling: 0,
        },
        secretGrants: [],
      },
    },
  };
}

describe('RunWorkspace Attempt panel (ticket 05, feature-gated)', () => {
  it('stays hidden when the feature gate is off, even for an eligible Run', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: eligibleRun(), structuredAttemptsEnabled: false }));

    expect(html).not.toContain('Start Attempt');
    expect(html).not.toContain('Attempt state');
  });

  it('offers a Start Attempt action for a Claude Run too — both runtimes have a real Attempt adapter', () => {
    const base = eligibleRun();
    if (base.envelope.state !== 'ready') throw new Error('expected a ready envelope');
    const run: WorkRun = {
      ...base,
      envelope: { state: 'ready', capabilityEnvelope: { ...base.envelope.capabilityEnvelope, runtime: 'claude' } },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onStart: () => undefined }));

    expect(html).toContain('Attempt state');
    expect(html).toContain('Start Attempt');
  });

  it('offers a Start Attempt action for an idle, eligible Run once the gate is on', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, {
      run: eligibleRun(), structuredAttemptsEnabled: true, onStart: () => undefined,
    }));

    expect(html).toContain('Start Attempt');
    expect(html).toContain('Idle');
  });

  it('offers no Start Attempt action without a handler, even when eligible', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: eligibleRun(), structuredAttemptsEnabled: true }));

    expect(html).not.toContain('Start Attempt');
  });

  it('reports a running Attempt in plain language, and offers no Start action once one is underway', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'running',
      attempt: {
        state: 'running',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'lifecycle', sequence: 1, at: '2026-09-01T00:05:01.000Z', phase: 'turn-started' },
          {
            kind: 'tool-activity', sequence: 2, at: '2026-09-01T00:05:02.000Z', tool: 'commandExecution', status: 'started', summary: 'npm test',
          },
          {
            kind: 'message', sequence: 3, at: '2026-09-01T00:05:03.000Z', role: 'assistant', text: 'Working on the fix now.',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onStart: () => undefined }));

    expect(html).not.toContain('Start Attempt');
    expect(html).toContain('Ran the tests');
    expect(html).toContain('Working on the fix now.');
    // Lifecycle bookkeeping is not a step a reader needs.
    expect(html).not.toContain('Turn started');
  });

  it('leads with the answer the Run was asked for, instead of burying it in the log', () => {
    const summary = 'AgentDeck is a local-first control panel for Claude Code and Codex CLI sessions on macOS.';
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'tool-activity',
            sequence: 1,
            at: '2026-09-01T00:05:01.000Z',
            tool: 'commandExecution',
            status: 'completed',
            summary: `/bin/zsh -lc "pwd && rg --files -g '!*node_modules*' | sed -n '1,240p'"`,
          },
          { kind: 'message', sequence: 2, at: '2026-09-01T00:05:02.000Z', role: 'assistant', text: summary },
          { kind: 'usage', sequence: 3, at: '2026-09-01T00:05:03.000Z', inputTokens: 4200, outputTokens: 310 },
          { kind: 'completion', sequence: 4, at: '2026-09-01T00:06:00.000Z', outcome: 'success' },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Result');
    expect(html).toContain(summary);
    expect(html).toContain('Searched the repository for source files');
    expect(html).toContain('Completed successfully');
    expect(html).toContain('4,200 in / 310 out tokens');
    // The exact shell is kept in the durable log but stays behind the toggle:
    // this feed is read by people who do not read /bin/zsh.
    expect(html).not.toContain('/bin/zsh');
    expect(html).toContain('Show technical detail');
  });

  it('says plainly that a completed Attempt produced no written answer, rather than showing an empty Result', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'completion', sequence: 1, at: '2026-09-01T00:06:00.000Z', outcome: 'no-changes' },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('This Run produced no written answer.');
    expect(html).toContain('Completed without changing any files');
  });

  it('presents a verified, committed Run\'s result as a structured summary, never requiring the raw event log (ticket 10 AC5)', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'completion', sequence: 1, at: '2026-09-01T00:05:30.000Z', outcome: 'success' },
          {
            kind: 'verification-check', sequence: 2, at: '2026-09-01T00:05:31.000Z', gate: 'tests', command: 'npm test',
            required: true, passed: true, exitCode: 0, evidence: 'ok',
          },
          {
            kind: 'commit-created', sequence: 3, at: '2026-09-01T00:05:32.000Z', sha: 'abc123def456', branch: 'agentdeck/run/eligible',
            signed: false, changedFiles: ['src/index.ts'],
          },
          {
            kind: 'verification-outcome', sequence: 4, at: '2026-09-01T00:06:00.000Z', outcome: 'verified', repairAttempts: 0,
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Run result');
    expect(html).toContain('src/index.ts');
    expect(html).toContain('abc123def456'.slice(0, 12));
    expect(html).toContain('agentdeck/run/eligible');
    expect(html).toContain('tests');
    expect(html).toContain('npm test');
  });

  it('presents an honest non-success result for a failed Run, distinct from a successful one (ticket 10 AC7)', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'failed',
      attempt: {
        state: 'failed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        failedAt: '2026-09-01T00:06:00.000Z',
        reason: 'The sandboxed command exited non-zero.',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'failure', sequence: 1, at: '2026-09-01T00:06:00.000Z', reason: 'The sandboxed command exited non-zero.' },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Run result');
    expect(html).toContain('The sandboxed command exited non-zero.');
    expect(html).not.toContain('run-result-verification');
  });

  it('never tells a reader a failed Attempt succeeded', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'failed',
      attempt: {
        state: 'failed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        failedAt: '2026-09-01T00:06:00.000Z',
        reason: 'The sandboxed command exited non-zero.',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'tool-activity', sequence: 1, at: '2026-09-01T00:05:01.000Z', tool: 'commandExecution', status: 'failed', summary: 'npm test',
          },
          {
            kind: 'failure', sequence: 2, at: '2026-09-01T00:06:00.000Z', reason: 'The sandboxed command exited non-zero.',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).not.toContain('Completed successfully');
    // renderToStaticMarkup escapes the apostrophe.
    expect(html).toMatch(/Didn(?:&#x27;|')t finish/);
    expect(html).toContain('The sandboxed command exited non-zero.');
    expect(html).toContain('status-failed');
  });

  it('shows the terminal outcome for a completed Attempt', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'completion', sequence: 1, at: '2026-09-01T00:06:00.000Z', outcome: 'success',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Completed');
    expect(html).toContain('Success');
  });

  it('shows the precise failure reason as the terminal outcome for a failed Attempt', () => {
    const run: WorkRun = {
      ...eligibleRun(),
      status: 'failed',
      attempt: {
        state: 'failed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        failedAt: '2026-09-01T00:06:00.000Z',
        reason: 'The sandboxed command exited non-zero.',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          {
            kind: 'failure', sequence: 1, at: '2026-09-01T00:06:00.000Z', reason: 'The sandboxed command exited non-zero.',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Failed');
    expect(html).toContain('The sandboxed command exited non-zero.');
  });
});

describe('RunWorkspace pending attention (ticket 07)', () => {
  function runningRun(pendingAttention: WorkRun['pendingAttention']): WorkRun {
    return {
      ...eligibleRun(),
      status: pendingAttention?.kind === 'approval' ? 'waiting_approval' : 'waiting_input',
      pendingAttention,
      attempt: {
        state: 'running',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
        ],
      },
    };
  }

  it('shows nothing attention-related for a Run with no pending request', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: eligibleRun(), structuredAttemptsEnabled: true }));
    expect(html).not.toContain('run-attention-request');
  });

  it('shows the reason and Approve/Deny actions for a pending approval request', () => {
    const run = runningRun({
      id: 'attention-1', kind: 'approval', reason: 'Approve command: rm -rf node_modules', requestedAt: '2026-09-01T00:05:01.000Z',
    });

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Approval requested');
    expect(html).toContain('Approve command: rm -rf node_modules');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Waiting approval status');
  });

  it('shows an input field instead of Approve/Deny for a pending input request', () => {
    const run = runningRun({
      id: 'attention-1', kind: 'input', reason: 'What framework should this use?', requestedAt: '2026-09-01T00:05:01.000Z',
    });

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).toContain('Input requested');
    expect(html).toContain('What framework should this use?');
    expect(html).toContain('Clarifying input');
    expect(html).not.toContain('Approval requested');
  });

  it('reflects waiting_approval and waiting_input as the Run status label', () => {
    const approvalHtml = renderToStaticMarkup(createElement(RunWorkspace, {
      run: runningRun({ id: 'attention-1', kind: 'approval', reason: 'Approve?', requestedAt: '2026-09-01T00:05:01.000Z' }),
      structuredAttemptsEnabled: true,
    }));
    expect(approvalHtml).toContain('Waiting approval');

    const inputHtml = renderToStaticMarkup(createElement(RunWorkspace, {
      run: runningRun({ id: 'attention-1', kind: 'input', reason: 'What next?', requestedAt: '2026-09-01T00:05:01.000Z' }),
      structuredAttemptsEnabled: true,
    }));
    expect(inputHtml).toContain('Waiting input');
  });
});

describe('RunWorkspace publication (ticket 13)', () => {
  function verifiedRun(): WorkRun {
    return {
      ...eligibleRun(),
      status: 'completed',
      attempt: {
        state: 'completed',
        runtime: 'codex',
        startedAt: '2026-09-01T00:05:00.000Z',
        completedAt: '2026-09-01T00:06:00.000Z',
        events: [
          { kind: 'lifecycle', sequence: 0, at: '2026-09-01T00:05:00.000Z', phase: 'attempt-started' },
          { kind: 'completion', sequence: 1, at: '2026-09-01T00:05:30.000Z', outcome: 'success' },
          {
            kind: 'commit-created', sequence: 2, at: '2026-09-01T00:05:32.000Z', sha: 'abc123def456', branch: 'agentdeck/run/eligible',
            signed: false, changedFiles: ['src/index.ts'],
          },
          { kind: 'verification-outcome', sequence: 3, at: '2026-09-01T00:06:00.000Z', outcome: 'verified', repairAttempts: 0 },
        ],
      },
    };
  }

  const publication = {
    id: 'pub-1',
    runId: 'run-durable-123',
    idempotencyKey: 'run:run-durable-123:commit:abc123def456',
    target: 'draft-pull-request' as const,
    commit: 'abc123def456',
    branch: 'agentdeck/run/eligible',
    authorizedBy: { id: 'local:admin', displayName: 'admin' },
    authorizedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };

  it('says plainly that a verified result is still local and offers the publish action, never publishing on its own (AC1)', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: verifiedRun(), structuredAttemptsEnabled: true, onPublish: () => undefined }));
    expect(html).toContain('Nothing has been pushed');
    expect(html).toContain('Push branch');
  });

  it('renders — and offers the publish action — with the experimental structured-attempts panel left off (AC2: the admin\'s only way to authorize a publish is never hidden behind that unrelated flag)', () => {
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run: verifiedRun(), onPublish: () => undefined }));
    expect(html).toContain('Nothing has been pushed');
    expect(html).toContain('Push branch');
    expect(html).toContain('Run result');
  });

  it('offers a draft pull request when that is what the requester asked for', () => {
    const run: WorkRun = { ...verifiedRun(), spec: { ...verifiedRun().spec, requestedDeliveryResult: 'pull-request' } };
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onPublish: () => undefined }));
    expect(html).toContain('Push and open draft pull request');
  });

  it('offers no publish action without a handler, for an unverified Run, or for one with no commit', () => {
    expect(renderToStaticMarkup(createElement(RunWorkspace, { run: verifiedRun(), structuredAttemptsEnabled: true }))).not.toContain('Push branch');
    const unverified: WorkRun = { ...verifiedRun(), status: 'completed_unverified' };
    expect(renderToStaticMarkup(createElement(RunWorkspace, { run: unverified, structuredAttemptsEnabled: true, onPublish: () => undefined })))
      .not.toContain('Publication');
  });

  it('shows a successful publication — state, target, authorizer, remote, and the draft pull request — with no further action (AC4)', () => {
    const run: WorkRun = {
      ...verifiedRun(),
      publication: {
        ...publication,
        state: 'succeeded',
        executions: 1,
        result: {
          remote: { name: 'origin', url: 'git@github.com:example/project.git' },
          branch: 'agentdeck/run/eligible',
          commit: 'abc123def456',
          pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42', title: 'Implement durable runs', draft: true },
        },
      },
    };
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onPublish: () => undefined }));
    for (const expected of ['Succeeded', 'Draft pull request', 'admin', 'git@github.com:example/project.git', 'https://github.com/example/project/pull/42', 'Draft pull request #42']) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('Retry publication');
    expect(html).not.toContain('Nothing has been pushed');
  });

  it('presents an ambiguous outcome as requiring the admin, with its reason and a reconcile-and-retry action (AC6)', () => {
    const run: WorkRun = {
      ...verifiedRun(),
      publication: { ...publication, state: 'ambiguous', executions: 1, reason: 'origin could not be observed afterward.' },
    };
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onPublish: () => undefined }));
    expect(html).toContain('Ambiguous');
    expect(html).toContain('outcome is unknown');
    expect(html).toContain('origin could not be observed afterward.');
    expect(html).toContain('Reconcile and retry');
  });

  it('presents a failed publication with its reason and a retry action', () => {
    const run: WorkRun = {
      ...verifiedRun(),
      publication: { ...publication, state: 'failed', executions: 2, reason: 'origin/agentdeck/run/eligible is at 999, not the authorized commit.' },
    };
    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true, onPublish: () => undefined }));
    expect(html).toContain('not the authorized commit');
    expect(html).toContain('Retry publication');
  });
});
