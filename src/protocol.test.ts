import { describe, expect, it } from 'vitest';
import { parseClientFrame, TERMINAL_COLS, TERMINAL_ROWS } from './protocol.js';

describe('VS Code protocol frames', () => {
  it('accepts bounded terminal registrations and action results', () => {
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_register', windowId: 'window-1',
      terminals: [{ id: 'term-1', name: 'Claude', processId: 123 }],
    }))).toEqual({
      t: 'vscode_register', windowId: 'window-1',
      terminals: [{ id: 'term-1', name: 'Claude', processId: 123 }],
    });
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_result', requestId: 'request-1', ok: false, error: 'gone',
    }))).toEqual({ t: 'vscode_result', requestId: 'request-1', ok: false, error: 'gone' });
  });

  it('rejects malformed process ids and oversized registration fields', () => {
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_register', windowId: 'window-1',
      terminals: [{ id: 'term-1', name: 'Claude', processId: -1 }],
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_register', windowId: 'x'.repeat(201), terminals: [],
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'attach', sessionId: 'x'.repeat(201) }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'input', data: 'x'.repeat(64 * 1024 + 1) }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_result', requestId: 'request-1', ok: false, error: 'x'.repeat(4097),
    }))).toBeNull();
  });

  it('accepts only boolean UI presence values', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'ui_presence', visible: true })))
      .toEqual({ t: 'ui_presence', visible: true });
    expect(parseClientFrame(JSON.stringify({ t: 'ui_presence', visible: 'yes' }))).toBeNull();
  });

  it('no longer recognizes resize frames — terminal size is pinned, not viewer-controlled', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))).toBeNull();
    expect(TERMINAL_COLS).toBe(100);
    expect(TERMINAL_ROWS).toBe(30);
  });
});
