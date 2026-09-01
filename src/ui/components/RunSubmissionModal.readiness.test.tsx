// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeReadinessReportFixture } from '../../test-fixtures/runtime-readiness.js';
import type { Repo } from '../../types.js';
import { RunSubmissionModal } from './RunSubmissionModal.js';

const repo: Repo = { id: '/repos/example', path: '/repos/example', name: 'example', currentBranch: 'main' };

describe('RunSubmissionModal runtime readiness', () => {
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

  it('shows each runtime checkbox\'s fetched readiness result where the preference is selected', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/runtime-readiness') throw new Error(`Unexpected request: ${String(input)}`);
      return { ok: true, status: 200, json: async () => runtimeReadinessReportFixture } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(RunSubmissionModal, {
        onClose: () => undefined, onError: () => undefined, onSubmitted: () => undefined, repos: [repo],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/runtime-readiness', expect.any(Object));
    expect(container.textContent).toContain('Managed runs ready');
    expect(container.textContent).toContain('Compatibility only');
  });
});
