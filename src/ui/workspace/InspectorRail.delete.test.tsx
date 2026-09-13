import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import { InspectorRail } from './InspectorRail.js';

const endedSession: Session = {
  id: 'session-1', origin: 'managed', agent: 'codex', cwd: '/repos/example',
  startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
  status: 'exited', statusSource: 'process_gone', endedAt: '2026-09-01T00:05:00.000Z',
};
const render = (session: Session, onDelete?: (session: Session) => void) => renderToStaticMarkup(createElement(InspectorRail, {
  onAction: () => undefined, onError: () => undefined, onRename: () => undefined, selected: session, ...(onDelete ? { onDelete } : {}),
}));

describe('InspectorRail session deletion (formerly History)', () => {
  it('offers deletion only for an ended session and only with a handler', () => {
    expect(render(endedSession)).not.toContain('Delete session');
    expect(render(endedSession, () => undefined)).toContain('Delete session');
    expect(render({ ...endedSession, status: 'working', endedAt: undefined }, () => undefined)).not.toContain('Delete session');
  });

  it('keeps PID and TTY under Advanced details', () => {
    const html = render({ ...endedSession, pid: 4711 });
    expect(html.indexOf('4711')).toBeGreaterThan(html.indexOf('Advanced details'));
  });
});
