// SessionTranscript: owns everything about the bytes a managed session
// produces. Replaces direct RingBuffer usage in SessionManager and moves the
// per-chunk fan-out to viewers into a single coalesced timer, so a spinner
// animating at 10-30 chunks/sec doesn't turn into 10-30 WS messages/sec (or,
// before this module existed, 10-30 synchronous sqlite writes/sec) per
// session. It also owns the on-disk layout for a session's output: a
// 5 MB-tail-capped raw.log while the session is live, and — once, on
// exit, no model call — a permanent scrollback.txt produced by replaying
// raw.log through ScrollbackRenderer. See
// docs/specs/session-persistence-and-remote-access.md ("SessionTranscript"
// under Module design, and "Storage" for the on-disk layout).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TERMINAL_COLS } from '../protocol.js';
import { RingBuffer } from './ringbuffer.js';
import { render } from './scrollback-renderer.js';

export type Unsubscribe = () => void;

export interface SessionTranscriptOptions {
  /** Which session this transcript belongs to — names its on-disk subdirectory. */
  sessionId: string;
  /** Base directory all sessions' raw/scrollback files live under (config.dataDir + "sessions"). */
  sessionsDir: string;
  /** in-memory ring buffer capacity for snapshot()/replay-on-attach (bytes-ish; string length) */
  capacity?: number;
  /** batching window for subscribe() callbacks, ms */
  coalesceMs?: number;
  /** raw.log tail cap on disk, bytes. Spec: 5 MB — newest kept, oldest dropped. */
  maxRawBytes?: number;
  /** terminal width scrollback is replayed at on close(). Managed sessions are pinned at TERMINAL_COLS. */
  cols?: number;
}

const DEFAULT_CAPACITY = 64 * 1024;
const DEFAULT_COALESCE_MS = 16;
const DEFAULT_MAX_RAW_BYTES = 5 * 1024 * 1024;

export function sessionDir(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId);
}
export function rawLogPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionDir(sessionsDir, sessionId), 'raw.log');
}
export function scrollbackFilePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionDir(sessionsDir, sessionId), 'scrollback.txt');
}

/** Read a previously compacted session's scrollback. undefined if none exists yet. */
export async function readScrollback(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(scrollbackFilePath(sessionsDir, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Shared by SessionTranscript.close() and compactOrphanedRawLog(): render, persist, delete raw. */
async function compact(dir: string, bytes: string, cols: number): Promise<{ scrollbackPath: string }> {
  const text = await render(bytes, { cols, mode: 'grid' });
  await fsp.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, 'scrollback.txt');
  await fsp.writeFile(outPath, text, 'utf8');
  await fsp.rm(path.join(dir, 'raw.log'), { force: true });
  return { scrollbackPath: outPath };
}

/**
 * Boot-time safety net: if the server process was killed hard enough that
 * a live session's SessionManager.handleExit never ran (e.g. `kill -9` on
 * the whole process, not just the child), raw.log is left on disk with no
 * matching scrollback.txt — the session would otherwise be unreadable
 * forever. Call this once per managed session at boot (see
 * src/server/boot.ts); a no-op (returns undefined) unless raw.log exists.
 */
export async function compactOrphanedRawLog(
  sessionsDir: string,
  sessionId: string,
  cols: number = TERMINAL_COLS,
): Promise<{ scrollbackPath: string } | undefined> {
  let bytes: string;
  try {
    bytes = await fsp.readFile(rawLogPath(sessionsDir, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return compact(sessionDir(sessionsDir, sessionId), bytes, cols);
}

/**
 * Bounded record of a session's raw output, plus a coalesced fan-out to
 * subscribers (viewing WebSocket sockets), plus disk persistence. `append`
 * is the hot path — it must stay cheap and synchronous; disk writes happen
 * off the coalescing timer, not on every append. `subscribe` callbacks
 * fire on that same timer, not on every `append`.
 */
export class SessionTranscript {
  private buffer: RingBuffer;
  private readonly coalesceMs: number;
  private subscribers = new Set<(data: string) => void>();
  private pending = '';
  private timer?: NodeJS.Timeout;

  private readonly dir: string;
  private readonly rawLog: string;
  private readonly cols: number;
  // Mirrors exactly what belongs in raw.log (same 5 MB tail cap, same
  // drop-oldest-whole-chunk semantics as the in-memory `buffer`). close()
  // compacts straight from this in-memory copy rather than reading the
  // file back, so a graceful exit never has to round-trip through disk.
  private diskTail: RingBuffer;
  private pendingWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: SessionTranscriptOptions) {
    this.buffer = new RingBuffer(opts.capacity ?? DEFAULT_CAPACITY);
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.dir = sessionDir(opts.sessionsDir, opts.sessionId);
    this.rawLog = path.join(this.dir, 'raw.log');
    this.cols = opts.cols ?? TERMINAL_COLS;
    this.diskTail = new RingBuffer(opts.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Record a chunk of output. Cheap: a ring-buffer push plus a string concat. */
  append(data: string): void {
    if (data === '' || this.closed) return;
    this.buffer.push(data);
    this.pending += data;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
      // Never hold the process open just to deliver a terminal batch.
      this.timer.unref?.();
    }
  }

  /** Full buffered output, for replay when a viewer (re)attaches. */
  snapshot(): string {
    return this.buffer.snapshot();
  }

  /** Subscribe to coalesced output batches. Returns an unsubscribe function. */
  subscribe(cb: (data: string) => void): Unsubscribe {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Compact on exit: flush any output still sitting in the coalescing
   * window (nothing right before exit is lost), replay the tail-capped
   * bytes through ScrollbackRenderer, persist scrollback.txt, and delete
   * raw.log. Runs once, costs no model call. Callers (SessionManager)
   * close a transcript exactly once, on process exit.
   */
  async close(): Promise<{ scrollbackPath: string }> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending !== '') {
      this.diskTail.push(this.pending);
      this.pending = '';
    }
    this.closed = true;
    this.subscribers.clear();
    // Wait for any in-flight live spill write before deleting raw.log —
    // otherwise a write that was already in flight could recreate the file
    // right after compact() removes it.
    await this.pendingWrite;
    const bytes = this.diskTail.snapshot();
    const result = await compact(this.dir, bytes, this.cols);
    this.buffer.clear();
    this.diskTail.clear();
    return result;
  }

  private flush(): void {
    this.timer = undefined;
    if (this.pending === '') return;
    const batch = this.pending;
    this.pending = '';
    for (const cb of this.subscribers) cb(batch);
    this.diskTail.push(batch);
    this.spillToDisk();
  }

  /** Best-effort live disk spill; a failure here must never crash the session. */
  private spillToDisk(): void {
    const data = this.diskTail.snapshot();
    this.pendingWrite = fsp.writeFile(this.rawLog, data, 'utf8').catch((error: unknown) => {
      console.error(`[agentdeck] failed to spill raw.log for session at ${this.dir}:`, error);
    });
  }
}
