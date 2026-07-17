import { describe, expect, it } from 'vitest';
import { parseClientFrame } from './protocol.js';

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
  });
});
