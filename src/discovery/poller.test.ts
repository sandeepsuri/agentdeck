import { describe, expect, it, vi } from 'vitest';
import { Store } from '../store/index.js';
import type { Session } from '../types.js';
import { DiscoveryPoller } from './poller.js';
import type { TerminalRegistry } from './terminals/index.js';

const PS_HOT = '100 1 ttys001 S+ 4.2 Thu Jul 16 17:39:00 2026 claude';

describe('DiscoveryPoller', () => {
  it('requires sustained CPU before working, preserves labels, and removes disappeared sessions', async () => {
    const store = new Store(':memory:');
    const updates: Session[] = [];
    const removed: string[] = [];
    let psOutput = PS_HOT;
    const run = vi.fn(async (file: string) => {
      if (file === 'ps') return psOutput;
      if (file === 'lsof') return 'p100\nfcwd\nn/tmp\n';
      throw new Error(`unexpected ${file}`);
    });
    const poller = new DiscoveryPoller({
      store,
      getManagedPids: () => new Set(),
      publish: (session) => updates.push(session),
      remove: (sessionId) => removed.push(sessionId),
      run,
      resolveGit: async () => ({ repoId: '/tmp/repo', repoPath: '/tmp/repo', branch: 'main' }),
    });

    await poller.poll();
    const id = `ext-100-${Math.floor(new Date('Thu Jul 16 17:39:00 2026').getTime() / 1000)}`;
    expect(store.getSession(id)).toMatchObject({ status: 'idle', statusSource: 'cpu_heuristic' });
    const labeled = store.getSession(id);
    if (!labeled) throw new Error('missing discovered row');
    labeled.name = 'My external Claude';
    store.upsertSession(labeled);

    await poller.poll();
    expect(store.getSession(id)).toMatchObject({ name: 'My external Claude', status: 'working' });

    psOutput = '';
    await poller.poll();
    expect(store.getSession(id)).toBeUndefined();
    expect(removed).toEqual([id]);
    store.close();
  });

  it('publishes process sessions before a terminal adapter refresh completes', async () => {
    const store = new Store(':memory:');
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const terminals = {
      refresh: vi.fn(() => refresh),
      lookup: vi.fn(() => undefined),
    } as unknown as TerminalRegistry;
    const poller = new DiscoveryPoller({
      store,
      getManagedPids: () => new Set(),
      publish: vi.fn(),
      remove: vi.fn(),
      terminals,
      run: vi.fn(async (file: string) => file === 'ps' ? PS_HOT : 'p100\nfcwd\nn/tmp\n'),
      resolveGit: async () => ({}),
    });

    const pending = poller.poll();
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1));
    expect(poller.status()).toMatchObject({ polling: true, detectedProcesses: 1 });
    finishRefresh();
    await pending;
    expect(poller.status()).toMatchObject({ polling: false, publishedSessions: 1 });
    store.close();
  });

  it('records a failed scan and recovers on a later poll', async () => {
    const store = new Store(':memory:');
    let fail = true;
    const poller = new DiscoveryPoller({
      store,
      getManagedPids: () => new Set(),
      publish: vi.fn(),
      remove: vi.fn(),
      run: vi.fn(async (file: string) => {
        if (file === 'ps' && fail) throw new Error('ps unavailable');
        return file === 'ps' ? PS_HOT : 'p100\nfcwd\nn/tmp\n';
      }),
      resolveGit: async () => ({}),
    });

    await expect(poller.poll()).rejects.toThrow('ps unavailable');
    expect(poller.status()).toMatchObject({ polling: false, lastError: 'ps unavailable' });
    fail = false;
    await poller.poll();
    expect(poller.status().lastError).toBeUndefined();
    expect(poller.status().lastCompletedAt).toBeDefined();
    expect(store.listSessions()).toHaveLength(1);
    store.close();
  });

  it('scans immediately on start and schedules the next scan after completion', async () => {
    const store = new Store(':memory:');
    let scans = 0;
    const poller = new DiscoveryPoller({
      store,
      intervalMs: 5,
      getManagedPids: () => new Set(),
      publish: vi.fn(),
      remove: vi.fn(),
      run: vi.fn(async (file: string) => {
        if (file === 'ps') scans += 1;
        return '';
      }),
    });

    poller.start();
    await vi.waitFor(() => expect(scans).toBeGreaterThanOrEqual(2));
    expect(poller.status().running).toBe(true);
    poller.stop();
    expect(poller.status().running).toBe(false);
    store.close();
  });
});
