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

  it('stays hidden for a Run whose envelope runtime is not Codex, even with the gate on', () => {
    const base = eligibleRun();
    if (base.envelope.state !== 'ready') throw new Error('expected a ready envelope');
    const run: WorkRun = {
      ...base,
      envelope: { state: 'ready', capabilityEnvelope: { ...base.envelope.capabilityEnvelope, runtime: 'claude' } },
    };

    const html = renderToStaticMarkup(createElement(RunWorkspace, { run, structuredAttemptsEnabled: true }));

    expect(html).not.toContain('Attempt state');
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
