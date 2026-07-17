import { describe, expect, it, vi } from 'vitest';
import { Store } from '../store/index.js';
import type { Session } from '../types.js';
import { DiscoveryPoller } from './poller.js';

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
});
