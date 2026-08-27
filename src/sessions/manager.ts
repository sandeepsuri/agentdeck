// SessionManager (T3): owns managed sessions — lifecycle, status derivation,
// initial-prompt injection, persistence, typed events. Output bytes
// themselves live in SessionTranscript (transcript.ts); this module holds
// one per live session and asks it to append/snapshot, but doesn't buffer.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import type { Store } from '../store/index.js';
import type { AgentMessage, AgentType, LaunchSpec, Session, SessionStatus } from '../types.js';
import { TERMINAL_COLS } from '../protocol.js';
import type { Handle, SessionBackend } from './backend.js';
import { readScrollback, SessionTranscript, type Unsubscribe } from './transcript.js';
import { readSummary, writeSummary } from './summary.js';
import { ClaudeCliSummarizer, type Summarizer, type SummarizeOptions } from './summarizer.js';
import { inferOutputStatus, reduceStatus, type StatusSignal } from './status.js';

// Observed CLI behavior: readiness = the CLI's composer/prompt line
// appears; trust dialog = first-run "do you trust this folder" screen that
// would swallow an injected prompt.
const READINESS: Record<AgentType, RegExp> = {
  claude: /❯ /,
  codex: /› /,
};
const TRUST_DIALOG = /trust this folder|Trusting the directory/i;

// lastActivityAt is allowed to lag (nothing user-visible depends on finer
// freshness); flushing it to sqlite at 4 Hz instead of once per PTY chunk is
// most of the win from extracting SessionTranscript. Status changes are
// still persisted immediately, from the same call site.
const ACTIVITY_FLUSH_MS = 250;

export interface SessionManagerOptions {
  /** SessionTranscript capacity per session (bytes-ish; string length) */
  bufferSize?: number;
  /** override readiness detection (tests use bash prompts) */
  readiness?: Partial<Record<AgentType, RegExp>>;
  /** send initialPrompt anyway after this long without a readiness match */
  promptFallbackMs?: number;
  /** SIGTERM → SIGKILL escalation delay */
  killGraceMs?: number;
  /** Base dir for sessions/<id>/{raw.log,scrollback.txt}. Default: config.dataDir/sessions. */
  sessionsDir?: string;
  /** raw.log tail cap per session, bytes. Default: 5 MB (spec). Tests shrink this. */
  maxRawBytes?: number;
  /**
   * Provider used by summarize() (ticket 11). Default: ClaudeCliSummarizer,
   * a `claude -p` subprocess adapter. Tests must always override this with
   * a fake — summarize() is the only thing that can invoke it, and it is
   * only ever reached via the explicit POST /api/sessions/:id/summarize
   * route, never automatically.
   */
  summarizer?: Summarizer;
}

export interface SessionManagerEvents {
  session_update: [session: Session];
  session_removed: [sessionId: string];
  output: [sessionId: string, data: string];
  agent_event: [event: AgentMessage];
}

interface Live {
  handle: Handle;
  transcript: SessionTranscript;
  unsubscribeOutput: Unsubscribe;
  promptTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  promptPending?: string;
  exited: boolean;
  /** epoch ms of the last lastActivityAt persist; throttles handleData's flush. */
  lastActivityFlush: number;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private live = new Map<string, Live>();
  // Restart data can include prompts, arguments, and environment secrets.
  // Managed processes die with this server, so keeping it in memory is both
  // sufficient for restart and safer than writing it to SQLite.
  private launchSpecs = new Map<string, LaunchSpec>();
  private hookSignals = new Map<string, StatusSignal>();
  private opts: Required<Omit<SessionManagerOptions, 'readiness'>> & {
    readiness: Record<AgentType, RegExp>;
  };

  constructor(
    private backend: SessionBackend,
    private store: Store,
    opts: SessionManagerOptions = {},
  ) {
    super();
    this.opts = {
      bufferSize: opts.bufferSize ?? 64 * 1024,
      promptFallbackMs: opts.promptFallbackMs ?? 20000,
      killGraceMs: opts.killGraceMs ?? 5000,
      sessionsDir: opts.sessionsDir ?? path.join(defaultDataDir(), 'sessions'),
      maxRawBytes: opts.maxRawBytes ?? 5 * 1024 * 1024,
      summarizer: opts.summarizer ?? new ClaudeCliSummarizer(),
      readiness: { ...READINESS, ...opts.readiness },
    };
  }

  /** Spawn a managed session and persist its row. */
  async launch(spec: LaunchSpec): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      origin: 'managed',
      agent: spec.agent,
      cwd: spec.cwd,
      startedAt: now,
      lastActivityAt: now,
      status: 'starting',
      statusSource: 'output_heuristic',
      backend: 'pty',
    };
    if (spec.name !== undefined) session.name = spec.name;
    if (spec.branch !== undefined) session.branch = spec.branch;
    const repo = this.store.listRepos().find((candidate) => candidate.path === spec.cwd);
    if (repo) {
      session.repoId = repo.id;
      session.branch = spec.branch ?? repo.currentBranch;
    }
    this.launchSpecs.set(session.id, spec);
    try {
      await this.attachProcess(session, spec);
    } catch (error) {
      this.launchSpecs.delete(session.id);
      throw error;
    }
    return this.getSession(session.id) ?? session;
  }

  private async attachProcess(session: Session, spec: LaunchSpec): Promise<void> {
    const handle = await this.backend.spawn({
      ...spec,
      env: { ...(spec.env ?? {}), AGENTDECK_SESSION_ID: session.id },
    });
    session.pid = handle.pid;
    const transcript = new SessionTranscript({
      sessionId: session.id,
      sessionsDir: this.opts.sessionsDir,
      capacity: this.opts.bufferSize,
      maxRawBytes: this.opts.maxRawBytes,
      cols: TERMINAL_COLS,
    });
    // Relay coalesced batches as the same 'output' event consumers already
    // know, so ws.ts's per-viewer routing doesn't need to change: the
    // coalescing now happens once here instead of once per raw PTY chunk.
    const unsubscribeOutput = transcript.subscribe((data) => this.emit('output', session.id, data));
    const live: Live = {
      handle,
      transcript,
      unsubscribeOutput,
      exited: false,
      lastActivityFlush: Date.now(),
    };
    this.live.set(session.id, live);
    this.persist(session);

    if (spec.initialPrompt !== undefined && spec.initialPrompt !== '') {
      live.promptPending = spec.initialPrompt;
      live.promptTimer = setTimeout(() => this.flushPrompt(session.id), this.opts.promptFallbackMs);
    }

    this.backend.onData(handle, (data) => this.handleData(session.id, data));
    this.backend.onExit(handle, (exitCode) => this.handleExit(session.id, exitCode));
  }

  private handleData(sessionId: string, data: string): void {
    const live = this.live.get(sessionId);
    const session = this.store.getSession(sessionId);
    if (!live || !session) return;
    // Output bytes go straight to the transcript; it owns buffering and
    // batches the fan-out to viewers on its own timer. What's left here is
    // status inference plus a throttled activity-time flush — no more
    // synchronous persist() on every PTY chunk.
    live.transcript.append(data);
    session.lastActivityAt = new Date().toISOString();
    const now = Date.now();
    const wasStarting = session.status === 'starting';
    const originalStatus = session.status;
    const originalStatusSource = session.statusSource;

    // `waiting_input` here means a trust dialog was detected below: keep
    // watching for readiness so the held prompt still fires once the user
    // resolves the dialog by hand.
    if (session.status === 'starting' || session.status === 'waiting_input') {
      const readiness = this.opts.readiness[session.agent];
      if (session.status === 'starting' && live.promptPending !== undefined && TRUST_DIALOG.test(data)) {
        // First-run trust dialog: injecting the prompt now would be swallowed
        // (T0 gotcha 2). Hold it and surface the dialog to the user.
        session.status = 'waiting_input';
      } else if (readiness.test(data)) {
        session.status = 'working';
        this.flushPrompt(sessionId);
      }
    }
    const outputStatus = inferOutputStatus(session.agent, data);
    if (outputStatus && !wasStarting) {
      const result = reduceStatus({
        alive: true,
        now,
        hook: this.hookSignals.get(sessionId),
        output: { status: outputStatus, at: now },
      });
      session.status = result.status;
      session.statusSource = result.statusSource;
    }

    // Status transitions are meaningful state changes, not per-chunk noise:
    // persist immediately, same as before extraction. Otherwise, the write
    // carries only a fresher lastActivityAt, which can lag — throttle it.
    const statusChanged = session.status !== originalStatus || session.statusSource !== originalStatusSource;
    if (statusChanged) {
      this.persist(session);
      live.lastActivityFlush = now;
    } else if (now - live.lastActivityFlush >= ACTIVITY_FLUSH_MS) {
      live.lastActivityFlush = now;
      this.persist(session);
    }
  }

  private flushPrompt(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live || live.promptPending === undefined || live.exited) return;
    const prompt = live.promptPending;
    live.promptPending = undefined;
    if (live.promptTimer) clearTimeout(live.promptTimer);
    this.backend.write(live.handle, prompt);
    // brief gap before Enter: both TUIs debounce paste-then-submit (T0)
    setTimeout(() => {
      if (!live.exited) this.backend.write(live.handle, '\r');
    }, 300);
  }

  /**
   * Runs on process exit (natural exit, stop(), or restart()'s internal
   * stop()). Marks the row exited immediately, then compacts the
   * transcript's output to scrollback (ticket 09: SessionTranscript.close()
   * — headless replay, no model call) before removing the live entry, so
   * `stop()`'s poll loop (and therefore SessionManager.shutdown()) does not
   * resolve until compaction has actually finished. A session that ends
   * while the server is shutting down must not end up unreadable; this is
   * what makes that true, since server/index.ts's close() awaits
   * manager.shutdown() before the process exits.
   */
  private async handleExit(sessionId: string, _exitCode: number): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) {
      live.exited = true;
      if (live.promptTimer) clearTimeout(live.promptTimer);
      if (live.killTimer) clearTimeout(live.killTimer);
      live.unsubscribeOutput();
    }
    // An ended session is the thing you reopen when you need to see what
    // happened (spec: "Ended sessions | Stay in the session rail ~1h, then
    // move to History") — keep the row, marked exited with the time it
    // ended, instead of deleting it. session_update (not session_removed)
    // tells viewers to keep showing it in its new, ended state.
    const session = this.store.getSession(sessionId);
    if (session) {
      session.status = 'exited';
      session.statusSource = 'process_gone';
      session.endedAt = new Date().toISOString();
      this.persist(session);
    }
    // The launch spec (which can carry prompts/env secrets) only exists to
    // support restart of a still-meaningfully-live session; once ended,
    // restart is a live-only affordance and should stop working, so it is
    // not kept around for a process that is already gone.
    this.launchSpecs.delete(sessionId);
    this.hookSignals.delete(sessionId);
    if (live) {
      try {
        await live.transcript.close();
      } catch (error) {
        // A compaction failure must not hang shutdown or leave the live
        // entry stuck around; the boot-time reconciler retries any raw.log
        // still left on disk the next time the server starts.
        console.error(`[agentdeck] failed to compact scrollback for session ${sessionId}:`, error);
      }
      this.live.delete(sessionId);
    }
  }

  /** Write raw input (keystrokes) to a live session. */
  write(sessionId: string, data: string): void {
    const live = this.requireLive(sessionId);
    this.backend.write(live.handle, data);
    const session = this.store.getSession(sessionId);
    if (session) {
      session.lastActivityAt = new Date().toISOString();
      // Same throttle as handleData's output path (spec Stage 1 step 3):
      // a keystroke isn't a meaningful state transition, so it shouldn't
      // force a synchronous persist. lastActivityAt may lag up to
      // ACTIVITY_FLUSH_MS; nothing user-visible depends on finer freshness.
      const now = Date.now();
      if (now - live.lastActivityFlush >= ACTIVITY_FLUSH_MS) {
        live.lastActivityFlush = now;
        this.persist(session);
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.requireLive(sessionId);
    this.backend.resize(live.handle, cols, rows);
  }

  /** SIGTERM, escalating to SIGKILL after killGraceMs. Resolves when exited. */
  async stop(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live || live.exited) return;
    const exited = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.live.has(sessionId)) {
          clearInterval(check);
          resolve();
        }
      }, 25);
    });
    await this.backend.kill(live.handle, 'SIGTERM');
    live.killTimer = setTimeout(() => {
      void this.backend.kill(live.handle, 'SIGKILL');
    }, this.opts.killGraceMs);
    await exited;
  }

  /** Stop (if live) and respawn from the in-memory launch spec. Same session id. */
  async restart(sessionId: string): Promise<Session> {
    const session = this.store.getSession(sessionId);
    const launchSpec = this.launchSpecs.get(sessionId);
    if (!session || session.origin !== 'managed' || !launchSpec) {
      throw new Error(`session ${sessionId} is not restartable`);
    }
    await this.stop(sessionId);
    session.status = 'starting';
    session.statusSource = 'output_heuristic';
    session.startedAt = new Date().toISOString();
    session.lastActivityAt = session.startedAt;
    this.launchSpecs.set(sessionId, launchSpec);
    try {
      await this.attachProcess(session, launchSpec);
    } catch (error) {
      this.launchSpecs.delete(sessionId);
      throw error;
    }
    return this.store.getSession(sessionId) ?? session;
  }

  /** Transcript contents for replay-on-attach. */
  getBuffer(sessionId: string): string {
    return this.live.get(sessionId)?.transcript.snapshot() ?? '';
  }

  getSession(sessionId: string): Session | undefined {
    return this.store.getSession(sessionId);
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  managedPids(): ReadonlySet<number> {
    return new Set(
      this.store.listSessions()
        .filter((session) => session.origin === 'managed' && session.status !== 'exited')
        .flatMap((session) => session.pid === undefined ? [] : [session.pid]),
    );
  }

  publishSessionUpdate(session: Session): void {
    this.emit('session_update', session);
  }

  publishSessionRemoved(sessionId: string): void {
    this.emit('session_removed', sessionId);
  }

  publishAgentEvent(event: AgentMessage): void {
    this.emit('agent_event', event);
  }

  applyHookStatus(sessionId: string, status: SessionStatus, at: string): Session | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    const signal = { status, at: Date.parse(at) };
    this.hookSignals.set(sessionId, signal);
    const result = reduceStatus({ alive: session.status !== 'exited', now: Date.now(), hook: signal });
    session.status = result.status;
    session.statusSource = result.statusSource;
    session.lastActivityAt = at;
    this.persist(session);
    return session;
  }

  renameSession(sessionId: string, name?: string): Session | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    if (name) session.name = name;
    else delete session.name;
    this.persist(session);
    return session;
  }

  /**
   * False as soon as the process has exited, even during the brief window
   * where handleExit is still compacting output and the live entry hasn't
   * been removed yet — `live.exited` flips synchronously, before any
   * `await`. isLive() reflects "has a process to talk to", not "internal
   * bookkeeping still in flight".
   */
  isLive(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return live !== undefined && !live.exited;
  }

  /** Stored scrollback for an ended managed session; undefined if it hasn't been compacted (yet). */
  async readScrollback(sessionId: string): Promise<string | undefined> {
    return readScrollback(this.opts.sessionsDir, sessionId);
  }

  /**
   * Generate (or regenerate) a wrap-up summary for an ended managed
   * session, from its stored scrollback. Manual, explicit action only —
   * this method is reached from exactly one place, the
   * POST /api/sessions/:id/summarize route (ticket 11). It is never called
   * from handleExit, shutdown(), boot reconciliation, or any timer/poll
   * loop; grep the class for callers of `this.summarize(` before adding
   * one anywhere else.
   *
   * The summarizer call happens before anything on disk or in the store is
   * touched, so a failure here leaves both the previous summary.md (if
   * any) and scrollback.txt completely intact — only a success replaces
   * the stored summary and its timestamp.
   */
  async summarize(sessionId: string, opts: SummarizeOptions = {}): Promise<string> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`no such session: ${sessionId}`);
    if (session.origin !== 'managed') {
      throw new Error('summarization is only available for managed sessions');
    }
    if (this.isLive(sessionId)) {
      throw new Error('session has not ended yet');
    }
    const scrollback = await readScrollback(this.opts.sessionsDir, sessionId);
    if (scrollback === undefined) {
      throw new Error('no scrollback is available to summarize');
    }
    const summary = await this.opts.summarizer.summarize(scrollback, opts);
    await writeSummary(this.opts.sessionsDir, sessionId, summary);
    session.summaryGeneratedAt = new Date().toISOString();
    this.persist(session);
    return summary;
  }

  /** Stored wrap-up summary for a session; undefined if none has been generated (yet). */
  async readSummary(sessionId: string): Promise<string | undefined> {
    return readSummary(this.opts.sessionsDir, sessionId);
  }

  /** Stop every live session (server shutdown). Resolves only once every session's output is compacted. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }

  private requireLive(sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live || live.exited) throw new Error(`session ${sessionId} has no live process`);
    return live;
  }

  private persist(session: Session): void {
    this.store.upsertSession(session);
    this.emit('session_update', session);
  }
}
