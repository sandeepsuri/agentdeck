import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness.js';
import type { Repo } from '../../types.js';
import { LaunchModal } from './LaunchModal.js';

const repo: Repo = {
  id: '/repos/agentdeck',
  path: '/repos/agentdeck',
  name: 'agentdeck',
  currentBranch: 'main',
};

const readiness: RuntimeReadinessReport = {
  checkedAt: '2026-09-01T14:00:00.000Z',
  runtimes: [
    {
      runtime: 'codex',
      displayName: 'Codex CLI',
      status: 'managed',
      version: '0.152.0',
      reason: 'All managed-run capabilities are available.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        { capability: 'execution-restrictions', supported: true },
      ],
    },
    {
      runtime: 'claude',
      displayName: 'Claude Code',
      status: 'compatibility-only',
      version: '2.0.0',
      reason: 'Missing managed-run capabilities: execution restrictions.',
      capabilities: [
        { capability: 'structured-events', supported: true },
        { capability: 'continuation', supported: true },
        { capability: 'approvals', supported: true },
        { capability: 'usage-reporting', supported: true },
        {
          capability: 'execution-restrictions',
          supported: false,
          reason: 'The installed CLI does not expose restricted execution controls.',
        },
      ],
    },
  ],
};

describe('LaunchModal runtime readiness', () => {
  it('shows independent status and the selected runtime capability explanation at the chooser', () => {
    const html = renderToStaticMarkup(createElement(LaunchModal, {
      onClose: () => undefined,
      onLaunched: () => undefined,
      repos: [repo],
      runtimeReadiness: readiness,
    }));

    expect(html).toContain('Managed runs ready');
    expect(html).toContain('Compatibility sessions only');
    expect(html).toContain('Missing managed-run capabilities: execution restrictions.');
    expect(html).toContain('Structured events');
    expect(html).toContain('Continuation');
    expect(html).toContain('Approvals');
    expect(html).toContain('Usage reporting');
    expect(html).toContain('Execution restrictions');
    expect(html).toContain('The installed CLI does not expose restricted execution controls.');
  });
});
