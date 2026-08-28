// Ticket 04: on boot, no managed session's PTY survived the previous
// process — but ended sessions must survive the restart, not be deleted.
// This is the seam that used to live inline in startServer() as an
// unconditional "delete every managed row + every exited row" loop.
//
// Ticket 09: boot is also the safety net for a raw.log a hard kill left
// behind with no scrollback.txt (SessionManager.handleExit never ran, so
// SessionTranscript.close() never compacted it) — no PTY survives a
// restart, so any raw.log found here is guaranteed orphaned, never a live
// session's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../types.js';
import { Store } from '../store/index.js';
import { rawLogPath, scrollbackFilePath } from '../sessions/transcript.js';
import { reconcileSessionsOnBoot } from './boot.js';

function session(over: Partial<Session>): Session {
  return {
    id: 'sess-1', origin: 'managed', agent: 'claude', cwd: '/repo',
    startedAt: '2026-08-27T09:00:00.000Z', lastActivityAt: '2026-08-27T09:05:00.000Z',
    status: 'working', statusSource: 'output_heuristic',
    ...over,
  };
}

let sessionsDir: string;
beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-boot-sessions-'));
});
afterEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe('reconcileSessionsOnBoot', () => {
  it('marks a managed session that was live when the server died as exited, with an endedAt', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'working' }));
    await reconcileSessionsOnBoot(store, sessionsDir);
    const row = store.getSession('a');
    expect(row?.status).toBe('exited');
    expect(row?.statusSource).toBe('process_gone');
    expect(row?.endedAt).toBeDefined();
    store.close();
  });

  it('keeps an already-ended managed session, without touching its original endedAt', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({
      id: 'a', status: 'exited', statusSource: 'process_gone', endedAt: '2026-08-27T08:00:00.000Z',
    }));
    await reconcileSessionsOnBoot(store, sessionsDir);
    expect(store.getSession('a')).toMatchObject({ status: 'exited', endedAt: '2026-08-27T08:00:00.000Z' });
    store.close();
  });

  it('never deletes a managed session row', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'starting' }));
    await reconcileSessionsOnBoot(store, sessionsDir);
    expect(store.listSessions()).toHaveLength(1);
    store.close();
  });

  it('leaves external sessions alone entirely (discovery reconciles them on its own)', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({
      id: 'ext-1', origin: 'external', status: 'idle', statusSource: 'cpu_heuristic',
    }));
    await reconcileSessionsOnBoot(store, sessionsDir);
    expect(store.getSession('ext-1')).toMatchObject({ status: 'idle' });
    store.close();
  });

  it('compacts a raw.log a hard kill left behind, with no scrollback.txt (ticket 09)', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'working' }));
    fs.mkdirSync(path.join(sessionsDir, 'a'), { recursive: true });
    fs.writeFileSync(rawLogPath(sessionsDir, 'a'), 'output from before the hard kill');

    await reconcileSessionsOnBoot(store, sessionsDir);

    expect(fs.readFileSync(scrollbackFilePath(sessionsDir, 'a'), 'utf8')).toBe('output from before the hard kill');
    expect(fs.existsSync(rawLogPath(sessionsDir, 'a'))).toBe(false);
    store.close();
  });

  it('is a no-op for a session with no raw.log (the normal, gracefully-compacted case)', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'a', status: 'exited', endedAt: '2026-08-27T08:00:00.000Z' }));
    await reconcileSessionsOnBoot(store, sessionsDir);
    expect(fs.existsSync(scrollbackFilePath(sessionsDir, 'a'))).toBe(false);
    store.close();
  });

  it('does not touch external sessions\' output at all', async () => {
    const store = new Store(':memory:');
    store.upsertSession(session({ id: 'ext-1', origin: 'external', status: 'idle', statusSource: 'cpu_heuristic' }));
    fs.mkdirSync(path.join(sessionsDir, 'ext-1'), { recursive: true });
    fs.writeFileSync(rawLogPath(sessionsDir, 'ext-1'), 'should be left alone');
    await reconcileSessionsOnBoot(store, sessionsDir);
    expect(fs.existsSync(rawLogPath(sessionsDir, 'ext-1'))).toBe(true);
    store.close();
  });
});
