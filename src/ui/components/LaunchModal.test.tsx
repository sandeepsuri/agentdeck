// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeReadinessReportFixture } from '../../test-fixtures/runtime-readiness.js';
import type { Repo } from '../../types.js';
import { LaunchModal } from './LaunchModal.js';

const repo: Repo = {
  id: '/repos/agentdeck',
  path: '/repos/agentdeck',
  name: 'agentdeck',
  currentBranch: 'main',
};

describe('LaunchModal runtime readiness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderWithReadiness(body: unknown) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/runtime-readiness') throw new Error(`Unexpected request: ${String(input)}`);
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(createElement(LaunchModal, {
        onClose: () => undefined,
        onLaunched: () => undefined,
        repos: [repo],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetchMock;
  }

  it('fetches and shows independent status plus the selected runtime capability explanation', async () => {
    const fetchMock = await renderWithReadiness(runtimeReadinessReportFixture);

    expect(fetchMock).toHaveBeenCalledWith('/api/runtime-readiness', expect.any(Object));
    expect(container.textContent).toContain('Managed runs ready');
    expect(container.textContent).toContain('Compatibility sessions only');
    expect(container.textContent).toContain('Missing managed-run capabilities: execution restrictions.');
    expect(container.textContent).toContain('Structured events');
    expect(container.textContent).toContain('Continuation');
    expect(container.textContent).toContain('Approvals');
    expect(container.textContent).toContain('Usage reporting');
    expect(container.textContent).toContain('Execution restrictions');
    expect(container.textContent).toContain('The installed CLI does not expose restricted execution controls.');
  });

  it('renders an unavailable runtime and its precise reason from the fetched report', async () => {
    const unavailable = {
      ...runtimeReadinessReportFixture,
      runtimes: runtimeReadinessReportFixture.runtimes.map((runtime) => runtime.runtime === 'claude' ? {
        ...runtime,
        status: 'unavailable' as const,
        reason: 'Claude Code was found but its readiness probe timed out.',
        capabilities: runtime.capabilities.map((item) => ({
          ...item,
          supported: false,
          reason: `Could not verify ${item.capability}.`,
        })),
      } : runtime),
    };

    await renderWithReadiness(unavailable);

    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).toContain('Claude Code was found but its readiness probe timed out.');
    expect(container.textContent).toContain('Could not verify approvals.');
  });
});
