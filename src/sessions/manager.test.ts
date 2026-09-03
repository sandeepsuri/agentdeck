// T3 tests: SessionManager + PtyBackend against bash/cat — never the real CLIs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchSpec } from '../types.js';
import { Store } from '../store/index.js';
import { PtyBackend } from './pty.js';
import { RingBuffer } from './ringbuffer.js';
import { SessionTranscript } from './transcript.js';
import type { Summarizer } from './summarizer.js';
import { SessionManager, type SessionManagerOptions } from './manager.js';
import type { Handle, SessionBackend } from './backend.js';

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
  // Every managed launch now spills output to sessionsDir/<id>/raw.log and
  // compacts it on exit — point that at a throwaway tmpdir so tests never
  // touch the real ~/.agentdeck.
  const sessionsDir = opts.sessionsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'adk-manager-sessions-'));
  const manager = new SessionManager(backend, store, { ...opts, sessionsDir });
  cleanups.push(async () => {
    await manager.shutdown();
    store.close();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });
  return { manager, store, sessionsDir };
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

  it('write() throttles lastActivityAt persistence instead of writing on every keystroke', async () => {
    const { manager, store } = makeManager({}, 'cat');
    const s = await manager.launch(spec({}));
    const upsertSpy = vi.spyOn(store, 'upsertSession');
    upsertSpy.mockClear();
    for (let i = 0; i < 20; i++) manager.write(s.id, 'x');
    // 20 rapid keystrokes must not each trigger a synchronous persist.
    expect(upsertSpy.mock.calls.length).toBeLessThan(20);
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
    const updates: string[] = [];
    manager.on('session_update', (sess) => updates.push(sess.status));
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await manager.stop(s.id);
    expect(manager.isLive(s.id)).toBe(false);
    // ticket 04: an ended managed session's row is kept, not deleted.
    const row = store.getSession(s.id);
    expect(row?.status).toBe('exited');
    expect(row?.statusSource).toBe('process_gone');
    expect(row?.endedAt).toBeDefined();
    expect(updates).toContain('exited');
  });

  it('stop() escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { manager, store } = makeManager({ killGraceMs: 200 });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'trap "" TERM; echo T; sleep 60'] }));
    await waitFor(() => manager.getBuffer(s.id).includes('T')); // trap installed
    await manager.stop(s.id);
    expect(store.getSession(s.id)?.status).toBe('exited');
  }, 10000);

  it('stop() does not arm SIGKILL after SIGTERM reports exit synchronously', async () => {
    let onExit: ((exitCode: number) => void) | undefined;
    const kills: string[] = [];
    const handle: Handle = { id: 'sync-exit', pid: 1234 };
    const backend: SessionBackend = {
      spawn: async () => handle,
      write: () => undefined,
      onData: () => undefined,
      onExit: (_handle, callback) => { onExit = callback; },
      resize: () => undefined,
      kill: async (_handle, signal = 'SIGTERM') => {
        kills.push(signal);
        if (signal === 'SIGTERM') onExit?.(0);
      },
      list: async () => [],
    };
    const store = new Store(':memory:');
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-manager-sync-exit-'));
    const manager = new SessionManager(backend, store, { sessionsDir, killGraceMs: 10 });
    cleanups.push(async () => {
      await manager.shutdown();
      store.close();
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    });

    const launched = await manager.launch(spec({}));
    await manager.stop(launched.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(kills).toEqual(['SIGTERM']);
  });

  it('restart() uses an in-memory launch spec without persisting its secrets', async () => {
    const { manager, store } = makeManager();
    const s = await manager.launch(spec({
      extraArgs: ['-c', 'echo run; sleep 30'],
      env: { AGENTDECK_TEST_SECRET: 'not-for-sqlite' },
    }));
    expect(store.getSession(s.id)?.launchSpec).toBeUndefined();
    const firstPid = s.pid;
    const s2 = await manager.restart(s.id);
    expect(s2.id).toBe(s.id);
    expect(s2.pid).not.toBe(firstPid);
    expect(s2.status).toBe('starting');
    expect(store.listSessions()).toHaveLength(1);
    await waitFor(() => manager.getBuffer(s.id).includes('run'));
  });

  it('emits session_update (never session_removed) on natural exit, keeping the row', async () => {
    const { manager } = makeManager();
    const statuses: string[] = [];
    const removed: string[] = [];
    manager.on('session_update', (sess) => statuses.push(sess.status));
    manager.on('session_removed', (id) => removed.push(id));
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => statuses.includes('exited'));
    expect(statuses[0]).toBe('starting');
    expect(removed).toEqual([]);
    const row = manager.getSession(s.id);
    expect(row?.status).toBe('exited');
    expect(row?.endedAt).toBeDefined();
  });

  it('an ended session cannot be written to (isLive is false, write() throws)', async () => {
    const { manager } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => !manager.isLive(s.id));
    expect(() => manager.write(s.id, 'hello')).toThrow();
  });

  it('an ended session is not restartable (launch spec is discarded on exit)', async () => {
    const { manager } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');
    await expect(manager.restart(s.id)).rejects.toThrow(/not restartable/);
  });

  it('compacts output to scrollback on exit and deletes the raw log (ticket 09)', async () => {
    const { manager, sessionsDir } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo hello-from-session'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');

    const rawLog = path.join(sessionsDir, s.id, 'raw.log');
    const scrollback = path.join(sessionsDir, s.id, 'scrollback.txt');
    await waitFor(() => fs.existsSync(scrollback));
    expect(fs.existsSync(rawLog)).toBe(false); // raw deleted once converted
    expect(fs.readFileSync(scrollback, 'utf8')).toContain('hello-from-session');
  });

  it('exposes an ended session\'s scrollback through readScrollback()', async () => {
    const { manager, sessionsDir } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo readable-later'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');
    await waitFor(() => fs.existsSync(path.join(sessionsDir, s.id, 'scrollback.txt')));
    expect(await manager.readScrollback(s.id)).toContain('readable-later');
  });

  it('readScrollback() is undefined for a session that has not ended yet', async () => {
    const { manager } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    expect(await manager.readScrollback(s.id)).toBeUndefined();
  });

  it('stop() does not resolve until compaction has finished (shutdown-safety)', async () => {
    const { manager, sessionsDir } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await manager.stop(s.id);
    // stop() already resolved — compaction must be done, not still in flight.
    expect(fs.existsSync(path.join(sessionsDir, s.id, 'scrollback.txt'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, s.id, 'raw.log'))).toBe(false);
  });

  it('shutdown() waits for every live session\'s compaction to finish before resolving', async () => {
    const { manager, sessionsDir } = makeManager();
    const a = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    const b = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await manager.shutdown();
    for (const id of [a.id, b.id]) {
      expect(fs.existsSync(path.join(sessionsDir, id, 'scrollback.txt'))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, id, 'raw.log'))).toBe(false);
    }
  });

  it('shutdown() waits for compaction already in progress after a natural exit', async () => {
    const originalClose = SessionTranscript.prototype.close;
    let releaseCompaction!: () => void;
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });
    const closeSpy = vi.spyOn(SessionTranscript.prototype, 'close').mockImplementationOnce(async function (this: SessionTranscript) {
      await compactionGate;
      return originalClose.call(this);
    });
    const { manager, sessionsDir } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo natural-exit'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');

    let shutdownResolved = false;
    const shuttingDown = manager.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownResolved).toBe(false);

    releaseCompaction();
    await shuttingDown;
    closeSpy.mockRestore();
    expect(fs.existsSync(path.join(sessionsDir, s.id, 'scrollback.txt'))).toBe(true);
  });
});

describe('SessionManager.deleteSession', () => {
  it('refuses to delete a still-live session', async () => {
    const { manager } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await expect(manager.deleteSession(s.id)).rejects.toThrow(/still running/);
    expect(manager.getSession(s.id)).toBeDefined();
  });

  it('removes the row, its on-disk transcript directory, and emits session_removed for an ended session', async () => {
    const { manager, store, sessionsDir } = makeManager();
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo delete-me'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');
    await waitFor(() => fs.existsSync(path.join(sessionsDir, s.id, 'scrollback.txt')));

    const removed = vi.fn();
    manager.on('session_removed', removed);

    await manager.deleteSession(s.id);

    expect(manager.getSession(s.id)).toBeUndefined();
    expect(store.getSession(s.id)).toBeUndefined();
    expect(fs.existsSync(path.join(sessionsDir, s.id))).toBe(false);
    expect(removed).toHaveBeenCalledWith(s.id);
  });

  it('is a no-op safe to call for an id that no longer exists', async () => {
    const { manager } = makeManager();
    await expect(manager.deleteSession('no-such-session')).resolves.toBeUndefined();
  });
});

// ticket 11: SessionManager.summarize() / readSummary(). A fake Summarizer
// is injected throughout — the real `claude -p` subprocess adapter is never
// invoked in tests (see summarizer.test.ts, which covers that adapter with
// node:child_process mocked instead).
describe('SessionManager summarize (ticket 11)', () => {
  function fakeSummarizer(impl?: Summarizer['summarize']): Summarizer & { summarize: ReturnType<typeof vi.fn> } {
    return { summarize: vi.fn(impl ?? (async () => 'a fake summary')) };
  }

  it('rejects summarizing a session that has not ended yet', async () => {
    const summarizer = fakeSummarizer();
    const { manager } = makeManager({ summarizer });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'sleep 30'] }));
    await expect(manager.summarize(s.id)).rejects.toThrow(/not ended|has not ended/);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('rejects summarizing an unknown session', async () => {
    const { manager } = makeManager({ summarizer: fakeSummarizer() });
    await expect(manager.summarize('no-such-id')).rejects.toThrow(/no such session/);
  });

  it('rejects summarizing an external session', async () => {
    const summarizer = fakeSummarizer();
    const { manager, store } = makeManager({ summarizer });
    store.upsertSession({
      id: 'ext-1', origin: 'external', agent: 'codex', cwd: '/tmp',
      startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:00:00.000Z',
      status: 'idle', statusSource: 'cpu_heuristic',
    });
    await expect(manager.summarize('ext-1')).rejects.toThrow(/managed/);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('summarizes an ended session\'s scrollback, stores summary.md, and stamps summaryGeneratedAt', async () => {
    const summarizer = fakeSummarizer(async (scrollback) => `Summary of: ${scrollback.trim()}`);
    const { manager, store, sessionsDir } = makeManager({ summarizer });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo did-the-work'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');
    await waitFor(() => fs.existsSync(path.join(sessionsDir, s.id, 'scrollback.txt')));

    const result = await manager.summarize(s.id);
    expect(result).toContain('did-the-work');
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    const [scrollbackArg] = summarizer.summarize.mock.calls[0] as [string, unknown];
    expect(scrollbackArg).toContain('did-the-work');

    expect(fs.readFileSync(path.join(sessionsDir, s.id, 'summary.md'), 'utf8')).toBe(result);
    expect(store.getSession(s.id)?.summaryGeneratedAt).toBeDefined();
    expect(await manager.readSummary(s.id)).toBe(result);
  });

  it('waits for in-flight scrollback compaction before summarizing an ended session', async () => {
    const originalClose = SessionTranscript.prototype.close;
    let releaseCompaction!: () => void;
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });
    const closeSpy = vi.spyOn(SessionTranscript.prototype, 'close').mockImplementationOnce(async function (this: SessionTranscript) {
      await compactionGate;
      return originalClose.call(this);
    });
    const summarizer = fakeSummarizer();
    const { manager } = makeManager({ summarizer });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo wait-for-scrollback'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');

    const summary = manager.summarize(s.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summarizer.summarize).not.toHaveBeenCalled();

    releaseCompaction();
    await expect(summary).resolves.toBe('a fake summary');
    closeSpy.mockRestore();
    expect(summarizer.summarize).toHaveBeenCalledWith(expect.stringContaining('wait-for-scrollback'), {});
  });

  it('readSummary() is undefined until a summary has been generated', async () => {
    const { manager } = makeManager({ summarizer: fakeSummarizer() });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');
    expect(await manager.readSummary(s.id)).toBeUndefined();
  });

  it('regenerating replaces the stored summary and its timestamp', async () => {
    let call = 0;
    const summarizer = fakeSummarizer(async () => (call++ === 0 ? 'first summary' : 'second summary'));
    const { manager, store, sessionsDir } = makeManager({ summarizer });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');

    const first = await manager.summarize(s.id);
    const firstStamp = store.getSession(s.id)?.summaryGeneratedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await manager.summarize(s.id);

    expect(first).toBe('first summary');
    expect(second).toBe('second summary');
    expect(fs.readFileSync(path.join(sessionsDir, s.id, 'summary.md'), 'utf8')).toBe('second summary');
    expect(store.getSession(s.id)?.summaryGeneratedAt).not.toBe(firstStamp);
  });

  it('a failed regeneration leaves the previous summary and the scrollback untouched', async () => {
    let call = 0;
    const summarizer = fakeSummarizer(async () => {
      call++;
      if (call === 1) return 'good summary';
      throw new Error('claude -p failed: simulated failure');
    });
    const { manager, store, sessionsDir } = makeManager({ summarizer });
    const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
    await waitFor(() => manager.getSession(s.id)?.status === 'exited');

    await manager.summarize(s.id);
    const stampAfterFirst = store.getSession(s.id)?.summaryGeneratedAt;
    const scrollbackBefore = fs.readFileSync(path.join(sessionsDir, s.id, 'scrollback.txt'), 'utf8');

    await expect(manager.summarize(s.id)).rejects.toThrow(/simulated failure/);

    expect(fs.readFileSync(path.join(sessionsDir, s.id, 'summary.md'), 'utf8')).toBe('good summary');
    expect(store.getSession(s.id)?.summaryGeneratedAt).toBe(stampAfterFirst);
    expect(fs.readFileSync(path.join(sessionsDir, s.id, 'scrollback.txt'), 'utf8')).toBe(scrollbackBefore);
  });

  // Ticket 12: a stored default model (store.setSetting, never the API
  // key) is what "changing the default affects later wrap-ups" wires up.
  // An explicit per-call opts.model always wins and is never persisted --
  // that's the "per-summary override affects only that run" half.
  describe('default model (ticket 12)', () => {
    it('passes no model at all when no override and no stored default exist (ticket 11 behavior preserved)', async () => {
      const summarizer = fakeSummarizer();
      const { manager, store } = makeManager({ summarizer });
      const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
      await waitFor(() => manager.getSession(s.id)?.status === 'exited');
      expect(store.getSetting('defaultSummaryModel')).toBeUndefined();

      await manager.summarize(s.id);

      expect(summarizer.summarize).toHaveBeenCalledWith(expect.stringContaining('x'), {});
    });

    it('falls back to the stored default model when no per-call override is given', async () => {
      const summarizer = fakeSummarizer();
      const { manager, store } = makeManager({ summarizer });
      store.setSetting('defaultSummaryModel', 'openai:gpt-4o-mini');
      const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
      await waitFor(() => manager.getSession(s.id)?.status === 'exited');

      await manager.summarize(s.id);

      expect(summarizer.summarize).toHaveBeenCalledWith(expect.stringContaining('x'), { model: 'openai:gpt-4o-mini' });
    });

    it('a per-call override wins over the stored default', async () => {
      const summarizer = fakeSummarizer();
      const { manager, store } = makeManager({ summarizer });
      store.setSetting('defaultSummaryModel', 'openai:gpt-4o-mini');
      const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
      await waitFor(() => manager.getSession(s.id)?.status === 'exited');

      await manager.summarize(s.id, { model: 'claude-cli:sonnet' });

      expect(summarizer.summarize).toHaveBeenCalledWith(expect.stringContaining('x'), { model: 'claude-cli:sonnet' });
    });

    it('an override is never written back to the stored default', async () => {
      const summarizer = fakeSummarizer();
      const { manager, store } = makeManager({ summarizer });
      const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
      await waitFor(() => manager.getSession(s.id)?.status === 'exited');

      await manager.summarize(s.id, { model: 'claude-cli:sonnet' });

      expect(store.getSetting('defaultSummaryModel')).toBeUndefined();
    });

    it('changing the stored default affects a later wrap-up without any per-call change', async () => {
      const summarizer = fakeSummarizer();
      const { manager, store } = makeManager({ summarizer });
      const s = await manager.launch(spec({ extraArgs: ['-c', 'echo x'] }));
      await waitFor(() => manager.getSession(s.id)?.status === 'exited');

      await manager.summarize(s.id); // before any default is set
      expect(summarizer.summarize).toHaveBeenLastCalledWith(expect.stringContaining('x'), {});

      store.setSetting('defaultSummaryModel', 'claude-cli:sonnet');
      await manager.summarize(s.id); // regenerate, no override
      expect(summarizer.summarize).toHaveBeenLastCalledWith(expect.stringContaining('x'), { model: 'claude-cli:sonnet' });
    });
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
