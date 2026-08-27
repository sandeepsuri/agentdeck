// ScrollbackRenderer: turns a session's raw captured terminal bytes into
// clean, readable text by replaying them through a headless terminal — the
// same escape-sequence handling xterm.js already does live in the browser,
// run once, offline. Cursor moves, spinner frames, and clear-screen
// sequences resolve into the terminal's final visual state instead of
// surviving as overlapping repainted frames. See
// docs/specs/session-persistence-and-remote-access.md ("ScrollbackRenderer"
// under Module design).
//
// The spec sketches `render()` as a synchronous `bytes in, text out`
// function. @xterm/headless's Terminal.write only offers a callback (there
// is no writeSync), so this returns a Promise instead — it is still a pure
// function in every sense that matters here: no shared state, no I/O
// beyond the in-memory terminal buffer, deterministic output for a given
// input. Two intended callers per the spec: compaction on exit (this
// ticket, 'grid' mode) and the live mobile reflow view (Stage 4, 'reflow'
// mode — not implemented; out of scope here).
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export type ScrollbackMode = 'grid' | 'reflow';

export interface ScrollbackRenderOptions {
  /** terminal width to replay at — managed sessions use TERMINAL_COLS (protocol.ts). */
  cols: number;
  /**
   * 'grid': exact fixed-width replay, one output line per terminal row.
   * This is what compaction-on-exit uses.
   * 'reflow': variable-width reflow for the mobile view (Stage 4 scope).
   * Kept as a type option to match the spec's interface shape; calling
   * render() with it throws, since Stage 4 is not built here.
   */
  mode: ScrollbackMode;
}

// Comfortably larger than what a 5 MB raw.log tail cap can produce at any
// reasonable terminal width, so a full raw.log never gets silently
// truncated during replay.
const REPLAY_SCROLLBACK_LINES = 200_000;
const REPLAY_VIEWPORT_ROWS = 30;

/**
 * Replay `bytes` (raw PTY output, ANSI escapes and all) through a headless
 * terminal sized at `opts.cols` and return its final visible content as
 * plain text: one line per terminal row, trailing blank rows trimmed.
 * Costs no tokens; ~200ms of CPU for a full raw.log, per the spec.
 */
export async function render(bytes: string, opts: ScrollbackRenderOptions): Promise<string> {
  if (opts.mode === 'reflow') {
    throw new Error("ScrollbackRenderer 'reflow' mode is not implemented (Stage 4 scope)");
  }
  if (bytes === '') return '';
  const term = new Terminal({
    cols: opts.cols,
    rows: REPLAY_VIEWPORT_ROWS,
    scrollback: REPLAY_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => term.write(bytes, resolve));
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  } finally {
    term.dispose();
  }
}
