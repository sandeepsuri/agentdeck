// LiveReflow: periodically replays a live session's transcript through
// ScrollbackRenderer's existing 'grid' mode (at the PTY's real
// TERMINAL_COLS) and pushes the resulting plain text to whoever is watching
// — the mechanism behind Stage 4's mobile reflow view. See
// docs/specs/session-persistence-and-remote-access.md, "Live headless
// rendering" and Stage 4 step 3.
//
// Deliberately does NOT use ScrollbackRenderer's 'reflow' mode (still an
// unimplemented stub) — replaying at a non-native column count risks
// corrupting TUI output that uses absolute cursor positioning, the exact
// bug class Stage 2 eliminated for the desktop path. The phone's own CSS
// reflows this plain text to the viewport at render time.
//
// One timer per session, shared by every attached viewer, running only
// while at least one viewer is attached — "off entirely when no phone is
// connected" (docs/tickets/13-mobile-reflow-view.md) is enforced here: the
// timer for a session exists if and only if `sessions.has(sessionId)`.
import { render as scrollbackRender } from './scrollback-renderer.js';
import { TERMINAL_COLS } from '../protocol.js';

export type Unsubscribe = () => void;

interface TranscriptLike {
  snapshot(): string;
}

export interface LiveReflowOptions {
  /** How often a viewed session's transcript is re-rendered, ms. Default ~1s. */
  intervalMs?: number;
  /**
   * Injectable for tests, so LiveReflow's own timer/subscription semantics
   * can be verified under `vi.useFakeTimers()` without also driving
   * ScrollbackRenderer's internal (real-timer-based, @xterm/headless)
   * async write scheduling — that renderer is already covered by its own
   * tests (scrollback-renderer.test.ts). Defaults to the real thing: replay
   * at TERMINAL_COLS in 'grid' mode, exactly per the spec.
   */
  render?: (bytes: string) => Promise<string>;
}

const DEFAULT_INTERVAL_MS = 1000;

interface SessionState {
  callbacks: Set<(text: string) => void>;
  timer: NodeJS.Timeout;
  /** Most recent rendered text, if a tick has completed at least once — lets a late-joining viewer get a frame immediately without waiting for the next tick. */
  lastText?: string;
}

/**
 * `getTranscript` reaches a live session's transcript without this module
 * depending on SessionManager directly (see SessionManager.getTranscript).
 * Returning undefined (session not live, or never existed) makes a tick a
 * silent no-op rather than an error — a viewer can stay attached across a
 * session ending.
 */
export class LiveReflow {
  private readonly getTranscript: (sessionId: string) => TranscriptLike | undefined;
  private readonly intervalMs: number;
  private readonly render: (bytes: string) => Promise<string>;
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    getTranscript: (sessionId: string) => TranscriptLike | undefined,
    opts: LiveReflowOptions = {},
  ) {
    this.getTranscript = getTranscript;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.render = opts.render ?? ((bytes) => scrollbackRender(bytes, { cols: TERMINAL_COLS, mode: 'grid' }));
  }

  /**
   * Subscribe to a session's periodically re-rendered text. The first
   * attach for a session starts its shared timer and fires an immediate
   * render so this viewer doesn't wait a full interval for a first frame;
   * a concurrent attach for the same session reuses that timer and, if a
   * render has already completed, gets the latest text immediately too.
   * The returned unsubscribe removes only this callback; the timer is
   * cleared once the last viewer for a session unsubscribes.
   */
  attach(sessionId: string, cb: (text: string) => void): Unsubscribe {
    let state = this.sessions.get(sessionId);
    const isNew = !state;
    if (!state) {
      state = { callbacks: new Set() } as SessionState;
      this.sessions.set(sessionId, state);
    }
    state.callbacks.add(cb);

    if (isNew) {
      state.timer = setInterval(() => { void this.tick(sessionId); }, this.intervalMs);
      state.timer.unref?.();
      void this.tick(sessionId);
    } else if (state.lastText !== undefined) {
      cb(state.lastText);
    }

    return () => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      current.callbacks.delete(cb);
      if (current.callbacks.size === 0) {
        clearInterval(current.timer);
        this.sessions.delete(sessionId);
      }
    };
  }

  private async tick(sessionId: string): Promise<void> {
    const transcript = this.getTranscript(sessionId);
    if (!transcript) return;
    const text = await this.render(transcript.snapshot());
    // Re-check after the await: the last viewer may have detached (clearing
    // this session's state) while the render was in flight.
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.lastText = text;
    for (const cb of state.callbacks) cb(text);
  }
}
