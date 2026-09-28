// Scrolling and sizing for the pinned-grid managed terminal. The PTY is a
// fixed TERMINAL_COLS×TERMINAL_ROWS, so instead of letting a small pane
// scroll around the grid (a second scroller fighting xterm's own), the font
// shrinks until the whole grid fits, and the wheel always scrolls xterm's
// history — even when the TUI asked for mouse reporting, which would
// otherwise turn wheel ticks into keystrokes sent to the agent.

export const BASE_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;

/**
 * Largest font (in half-pixel steps, capped at BASE_FONT_SIZE) whose grid
 * fits the pane, given the grid's measured size at BASE_FONT_SIZE.
 */
export function fitFontSize(
  pane: { width: number; height: number },
  gridAtBase: { width: number; height: number },
): number {
  if (gridAtBase.width <= 0 || gridAtBase.height <= 0 || pane.width <= 0 || pane.height <= 0) return BASE_FONT_SIZE;
  const scale = Math.min(1, pane.width / gridAtBase.width, pane.height / gridAtBase.height);
  return Math.max(MIN_FONT_SIZE, Math.floor(BASE_FONT_SIZE * scale * 2) / 2);
}

/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Converts wheel deltas to whole terminal lines, carrying the fractional
 * remainder so slow trackpad scrolling still moves instead of rounding to 0.
 */
export function createWheelAccumulator() {
  let remainder = 0;
  return (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, rowHeight: number, rows: number): number => {
    const lines = event.deltaMode === DOM_DELTA_LINE ? event.deltaY
      : event.deltaMode === DOM_DELTA_PAGE ? event.deltaY * rows
        : event.deltaY / Math.max(1, rowHeight);
    remainder += lines;
    const whole = Math.trunc(remainder);
    remainder -= whole;
    return whole;
  };
}

/** True when the viewport shows the newest output. */
export function isAtBottom(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY >= buffer.baseY;
}
