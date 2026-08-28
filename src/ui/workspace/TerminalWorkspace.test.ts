import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import { TerminalWorkspace } from './TerminalWorkspace.js';

const endedSession: Session = {
  id: 'ended-session',
  origin: 'managed',
  agent: 'claude',
  cwd: '/repos/agentdeck',
  branch: 'main',
  startedAt: '2026-08-27T12:00:00.000Z',
  lastActivityAt: '2026-08-27T12:30:00.000Z',
  endedAt: '2026-08-27T12:30:00.000Z',
  status: 'exited',
  statusSource: 'process_gone',
  backend: 'pty',
};

describe('TerminalWorkspace', () => {
  it('hides message controls for an ended managed session', () => {
    const html = renderToStaticMarkup(createElement(TerminalWorkspace, {
      onError: () => undefined,
      onFocusExternal: () => undefined,
      session: endedSession,
      sessions: [endedSession],
      ws: null,
      wsReady: false,
    }));

    expect(html).not.toContain('Send to PTY');
    expect(html).not.toContain('Type a response, or queue the next instruction');
    expect(html).not.toContain('>Queue<');
    expect(html).not.toContain('Send ⌘⏎');
  });
});
