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
    expect(parseClientFrame(JSON.stringify({
      t: 'input', sessionId: 'session-1', data: 'x'.repeat(64 * 1024 + 1),
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'vscode_result', requestId: 'request-1', ok: false, error: 'x'.repeat(4097),
    }))).toBeNull();
  });

  it('accepts only boolean UI presence values', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'ui_presence', visible: true })))
      .toEqual({ t: 'ui_presence', visible: true });
    expect(parseClientFrame(JSON.stringify({ t: 'ui_presence', visible: 'yes' }))).toBeNull();
  });

  it('requires terminal input and detach frames to identify their session', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'input', sessionId: 'session-1', data: 'ls\r' })))
      .toEqual({ t: 'input', sessionId: 'session-1', data: 'ls\r' });
    expect(parseClientFrame(JSON.stringify({ t: 'detach', sessionId: 'session-1' })))
      .toEqual({ t: 'detach', sessionId: 'session-1' });
    expect(parseClientFrame(JSON.stringify({ t: 'input', data: 'ls\r' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'detach' }))).toBeNull();
  });

  it('no longer recognizes resize frames — terminal size is pinned, not viewer-controlled', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))).toBeNull();
    expect(TERMINAL_COLS).toBe(100);
    expect(TERMINAL_ROWS).toBe(30);
  });
});

describe('ticket 07: run_attention_resolve frames', () => {
  it('accepts an approve or deny decision naming the run and attention request', () => {
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'approve',
    }))).toEqual({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'approve',
    });
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'deny',
    }))).toEqual({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'deny',
    });
  });

  it('accepts an input decision carrying non-empty clarifying text', () => {
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input', value: 'Use TypeScript',
    }))).toEqual({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input', value: 'Use TypeScript',
    });
  });

  it('rejects a missing runId/attentionId, an unrecognized decision, and an input decision with no value', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'run_attention_resolve', attentionId: 'attention-1', decision: 'approve' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'run_attention_resolve', runId: 'run-1', decision: 'approve' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'maybe',
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input',
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input', value: '',
    }))).toBeNull();
  });

  it('rejects oversized runId/attentionId/value fields', () => {
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'x'.repeat(201), attentionId: 'attention-1', decision: 'approve',
    }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({
      t: 'run_attention_resolve', runId: 'run-1', attentionId: 'attention-1', decision: 'input', value: 'x'.repeat(64 * 1024 + 1),
    }))).toBeNull();
  });
});
