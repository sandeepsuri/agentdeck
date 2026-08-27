// ScrollbackRenderer: bytes in, text out. Fixture bytes → expected text,
// per docs/specs/session-persistence-and-remote-access.md ("Pure-function
// shape; tested with fixture bytes in and expected text out").
import { describe, expect, it } from 'vitest';
import { render } from './scrollback-renderer.js';

describe('render (grid mode)', () => {
  it('passes plain text through unchanged', async () => {
    const text = await render('hello world\r\nsecond line\r\n', { cols: 40, mode: 'grid' });
    expect(text).toBe('hello world\nsecond line');
  });

  it('resolves carriage-return overwrites into the final visible line, not both frames', async () => {
    // A progress readout that overwrites itself in place, as a real CLI
    // spinner would: "1%" then "\r" back to column 0, then "99%" over it.
    const bytes = 'Loading: 1%\rLoading: 99%';
    const text = await render(bytes, { cols: 40, mode: 'grid' });
    expect(text).toBe('Loading: 99%');
  });

  it('resolves a clear-screen sequence, keeping only what is on screen after it', async () => {
    const bytes = 'stale spinner frame\x1b[2J\x1b[Hfinal prompt';
    const text = await render(bytes, { cols: 40, mode: 'grid' });
    expect(text).toBe('final prompt');
  });

  it('keeps wrapped rows as separate lines at the fixed column width (grid mode)', async () => {
    const bytes = 'a'.repeat(15); // wraps once at cols: 10
    const text = await render(bytes, { cols: 10, mode: 'grid' });
    expect(text).toBe('aaaaaaaaaa\naaaaa');
  });

  it('trims trailing blank rows but keeps interior blank lines', async () => {
    const bytes = 'first\r\n\r\nthird\r\n';
    const text = await render(bytes, { cols: 40, mode: 'grid' });
    expect(text).toBe('first\n\nthird');
  });

  it('returns an empty string for empty input without constructing a terminal', async () => {
    expect(await render('', { cols: 40, mode: 'grid' })).toBe('');
  });

  it('throws for reflow mode (Stage 4, not implemented here)', async () => {
    await expect(render('anything', { cols: 40, mode: 'reflow' })).rejects.toThrow(/reflow/);
  });
});
