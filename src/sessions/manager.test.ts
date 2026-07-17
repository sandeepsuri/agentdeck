// T3 tests: SessionManager + PtyBackend against bash/cat — never the real CLIs.
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../types.js';
import { Store } from '../store/index.js';
import { PtyBackend } from './pty.js';
import { RingBuffer } from './ringbuffer.js';
import { SessionManager, type SessionManagerOptions } from './manager.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** Manager whose "claude" is really `<file> <extraArgs…>` (default bash). */
function makeManager(opts: SessionManagerOptions = {}, file = 'bash') {
  const store = new Store(':memory:');
  const backend = new PtyBackend({
    commandFor: (spec: LaunchSpec) => ({ file, args: spec.extraArgs ?? [] }),
  });
  const manager = new SessionManager(backend, store, opts);
  cleanups.push(async () => {
    await manager.shutdown();
    store.close();
  });
  return { manager, store };
}

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('waitFor timed out'));
      }
    }, 20);
  });
}

const spec = (over: Partial<LaunchSpec>): LaunchSpec => ({
  agent: 'claude',
  cwd: '/tmp',
  ...over,
});

describe('SessionManager + PtyBackend', () => {
  it('spawns, receives output, persists the row, flips starting→working on readiness', async () => {
    const { manager, store } = makeManager({ readiness: { claude: /hello-from-child/ } });
    let streamed = '';
    manager.on('output', (_id, data) => (streamed += data));

    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo hello-from-child; sleep 3'] }));
    expect(s.origin).toBe('managed');
    expect(s.pid).toBeGreaterThan(0);
    expect(store.getSession(s.id)?.status).toBe('starting');

    await waitFor(() => streamed.includes('hello-from-child'));
    expect(store.getSession(s.id)?.status).toBe('working');
    expect(manager.getBuffer(s.id)).toContain('hello-from-child');
  });

  it('write() round-trips through cat', async () => {
    const { manager } = makeManager({}, 'cat');
    const s = await manager.launch(spec({}));
    manager.write(s.id, 'ping\r');
    await waitFor(() => manager.getBuffer(s.id).includes('ping'));
  });

  it('injects initialPrompt only after readiness, and the child executes it', async () => {
    const { manager } = makeManager({ readiness: { claude: /READY/ } });
    const s = await manager.launch(
      spec({
        // child prints READY, then runs whatever line arrives on stdin
        extraArgs: ['-c', 'echo READY; read line; eval "$line"; sleep 1'],
        initialPrompt: 'echo PROMPT_RAN',
      }),
    );
    await waitFor(() => manager.getBuffer(s.id).includes('PROMPT_RAN'));
  });

  it('holds the prompt and reports waiting_input on a trust dialog (T0 gotcha)', async () => {
    const { manager, store } = makeManager({ promptFallbackMs: 60000 });
    const s = await manager.launch(
      spec({
        extraArgs: ['-c', 'echo "Do you trust this folder?"; sleep 3'],
        initialPrompt: 'echo SHOULD_NOT_RUN',
      }),
    );
    await waitFor(() => store.getSession(s.id)?.status === 'waiting_input');
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.getBuffer(s.id)).not.toContain('SHOULD_NOT_RUN');
  });

  it('falls back to sending the prompt after promptFallbackMs without readiness', async () => {
    const { manager } = makeManager({ promptFallbackMs: 150 });
    const s = await manager.launch(
      spec({
        extraArgs: ['-c', 'read line; eval "$line"'], // prints nothing → no readiness match
        initialPrompt: 'echo FALLBACK_RAN',
      }),
    );
    await waitFor(() => manager.getBuffer(s.id).includes('FALLBACK_RAN'));
  });

  it('stop() SIGTERMs, removes the row, and emits session_removed', async () => {
    const { manager, store } = makeManager();
    const removed: string[] = [];
    manager.on('session_removed', (id) => removed.push(id));
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await manager.stop(s.id);
    expect(manager.isLive(s.id)).toBe(false);
    expect(store.getSession(s.id)).toBeUndefined();
    expect(removed).toContain(s.id);
  });

  it('stop() escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { manager, store } = makeManager({ killGraceMs: 200 });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'trap "" TERM; echo T; sleep 60'] }));
    await waitFor(() => manager.getBuffer(s.id).includes('T')); // trap installed
    await manager.stop(s.id);
    expect(store.getSession(s.id)).toBeUndefined();
  }, 10000);

  it('restart() respawns from the stored launchSpec with a fresh pid, same row', async () => {
    const { manager, store } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo run; sleep 30'] }));
    const firstPid = s.pid;
    const s2 = await manager.restart(s.id);
    expect(s2.id).toBe(s.id);
    expect(s2.pid).not.toBe(firstPid);
    expect(s2.status).toBe('starting');
    expect(store.listSessions()).toHaveLength(1);
    await waitFor(() => manager.getBuffer(s.id).includes('run'));
  });

  it('emits session_update while alive and session_removed on exit', async () => {
    const { manager } = makeManager();
    const statuses: string[] = [];
    const removed: string[] = [];
    manager.on('session_update', (sess) => statuses.push(sess.status));
    manager.on('session_removed', (id) => removed.push(id));
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => removed.includes(s.id));
    expect(statuses[0]).toBe('starting');
    expect(manager.getSession(s.id)).toBeUndefined();
  });
});

describe('RingBuffer', () => {
  it('replays pushed data and trims from the front at capacity', () => {
    const rb = new RingBuffer(10);
    rb.push('aaaa');
    rb.push('bbbb');
    expect(rb.snapshot()).toBe('aaaabbbb');
    rb.push('cccc'); // 12 > 10 → drop oldest chunk
    expect(rb.snapshot()).toBe('bbbbcccc');
  });

  it('keeps the tail of a single oversized chunk', () => {
    const rb = new RingBuffer(5);
    rb.push('0123456789');
    expect(rb.snapshot()).toBe('56789');
  });
});
