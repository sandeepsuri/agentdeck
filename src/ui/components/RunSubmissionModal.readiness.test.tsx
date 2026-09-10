// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import { runtimeReadinessReportFixture } from '../../test-fixtures/runtime-readiness.js';
import type { Repo } from '../../types.js';
import { RunSubmissionModal, runtimeSelectableForManagedRun } from './RunSubmissionModal.js';

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

// Ticket 14 AC6/AC8: what an operator can actually pick as a Run's runtime is
// decided by the shared readiness report alone — one rule for every runtime,
// no per-provider branch.
function readinessReport(claudeStatus: 'managed' | 'compatibility-only' | 'unavailable'): RuntimeReadinessReport {
  return {
    checkedAt: '2026-09-04T00:00:00.000Z',
    runtimes: [
      {
        runtime: 'codex',
        displayName: 'Codex CLI',
        status: 'managed',
        reason: 'All managed-run capabilities are available.',
        capabilities: [{ capability: 'execution-restrictions', supported: true }],
      },
      {
        runtime: 'claude',
        displayName: 'Claude Code',
        status: claudeStatus,
        version: '2.1.207',
        reason: claudeStatus === 'managed'
          ? 'All managed-run capabilities are available.'
          : 'Missing managed-run capabilities: approvals, usage reporting. Managed approval and usage protocols require Claude Code 2.1.208 or newer.',
        capabilities: [{
          capability: 'approvals',
          supported: claudeStatus === 'managed',
          ...(claudeStatus === 'managed' ? {} : { reason: 'The installed CLI does not expose managed approval controls.' }),
        }],
      },
    ],
  };
}

describe('runtimeSelectableForManagedRun', () => {
  it('allows only a runtime whose installation reports managed readiness', () => {
    expect(runtimeSelectableForManagedRun(readinessReport('managed'), 'claude')).toBe(true);
    expect(runtimeSelectableForManagedRun(readinessReport('compatibility-only'), 'claude')).toBe(false);
    expect(runtimeSelectableForManagedRun(readinessReport('unavailable'), 'claude')).toBe(false);
  });

  it('never blocks a choice on evidence it does not have yet', () => {
    expect(runtimeSelectableForManagedRun(null, 'claude')).toBe(true);
  });
});

describe('RunSubmissionModal runtime selection (ticket 14 AC6)', () => {
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

  async function mountWithReadiness(report: RuntimeReadinessReport): Promise<HTMLDivElement> {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/runtime-readiness')) {
        return { ok: true, status: 200, json: async () => report } as Response;
      }
      // The verification-policy lookup this modal also makes on mount.
      return { ok: true, status: 200, json: async () => ({ policy: null }) } as Response;
    }));
    await act(async () => {
      root.render(createElement(RunSubmissionModal, {
        onClose: () => undefined, onError: () => undefined, onSubmitted: () => undefined, repos: [repo],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  function runtimeCheckbox(host: HTMLElement, label: string): HTMLInputElement {
    const found = [...host.querySelectorAll('.run-choice-row label')]
      .find((element) => element.textContent?.startsWith(label));
    if (!found) throw new Error(`no runtime choice labelled ${label}`);
    return found.querySelector('input')!;
  }

  it('shows a compatibility-only Claude installation with its precise reason and refuses to let it be selected', async () => {
    const host = await mountWithReadiness(readinessReport('compatibility-only'));

    const claude = runtimeCheckbox(host, 'Claude');
    expect(claude.disabled).toBe(true);
    expect(claude.checked).toBe(false);
    expect(host.textContent).toContain('Compatibility only');
    expect(host.textContent).toContain('require Claude Code 2.1.208 or newer');

    await act(async () => { claude.click(); });
    expect(runtimeCheckbox(host, 'Claude').checked).toBe(false);
  });

  it('lets an eligible Run select Claude once its installation reports managed readiness', async () => {
    const host = await mountWithReadiness(readinessReport('managed'));

    const claude = runtimeCheckbox(host, 'Claude');
    expect(claude.disabled).toBe(false);
    expect(host.textContent).not.toContain('require Claude Code 2.1.208 or newer');

    await act(async () => { claude.click(); });
    expect(runtimeCheckbox(host, 'Claude').checked).toBe(true);
  });

  it('drops a runtime the readiness report says cannot run managed work, even the one this form defaults to', async () => {
    const report = readinessReport('managed');
    const codexUnavailable: RuntimeReadinessReport = {
      ...report,
      runtimes: report.runtimes.map((runtime) => (runtime.runtime === 'codex'
        ? { ...runtime, status: 'unavailable' as const, reason: 'Codex CLI is not installed or is not executable.' }
        : runtime)),
    };
    const host = await mountWithReadiness(codexUnavailable);

    const codex = runtimeCheckbox(host, 'Codex');
    expect(codex.disabled).toBe(true);
    expect(codex.checked).toBe(false);
    expect(host.textContent).toContain('Codex CLI is not installed or is not executable.');
    // With nothing selectable chosen, the Run cannot be queued at all.
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
