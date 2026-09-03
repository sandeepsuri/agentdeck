import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import { HistoryView } from './HistoryView.js';

const endedSession: Session = {
  id: 'session-1',
  origin: 'managed',
  agent: 'codex',
  cwd: '/repos/example',
  startedAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T00:05:00.000Z',
  status: 'exited',
  statusSource: 'process_gone',
  endedAt: '2026-09-01T00:05:00.000Z',
};

describe('HistoryView', () => {
  it('offers no delete affordance without an onDelete handler', () => {
    const html = renderToStaticMarkup(createElement(HistoryView, { repos: [], sessions: [endedSession] }));
    expect(html).not.toContain('Delete session');
  });

  it('offers a delete affordance per row once onDelete is provided', () => {
    const html = renderToStaticMarkup(createElement(HistoryView, {
      onDelete: () => undefined, repos: [], sessions: [endedSession],
    }));
    expect(html).toContain('Delete session');
  });

  it('still shows the empty-history state when there are no ended sessions to delete', () => {
    const html = renderToStaticMarkup(createElement(HistoryView, { onDelete: () => undefined, repos: [], sessions: [] }));
    expect(html).toContain('No history yet');
    expect(html).not.toContain('Delete session');
  });
});
