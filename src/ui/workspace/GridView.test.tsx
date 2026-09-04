// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../types.js';
import { GridView } from './GridView.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

class FakeWebSocket extends EventTarget {
  preview(sessionId: string, data: string) {
    this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ t: 'tile_preview', sessionId, data }),
    }));
  }
}

const session: Session = {
  id: 'session-1',
  origin: 'managed',
  agent: 'codex',
  cwd: '/repos/example',
  startedAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T00:00:00.000Z',
  status: 'working',
  statusSource: 'output_heuristic',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ws: FakeWebSocket) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<GridView onOpen={() => undefined} sessions={[session]} ws={ws as unknown as WebSocket} />);
  });
  return container;
}

afterEach(() => {
  if (root && container) act(() => { root!.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('GridView terminal preview', () => {
  it('presents each visible streamed line as a separate activity entry without changing its text', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws);
    const lines = Array.from({ length: 10 }, (_, index) => (
      `Update ${index + 1}: reviewing a deliberately long path /repos/example/src/features/mission-control/output.ts`
    ));

    act(() => { ws.preview(session.id, `${lines.join('\n')}\n`); });

    const entries = Array.from(host.querySelectorAll('.preview-entry'));
    const activityLog = host.querySelector('[role="log"]');
    expect(entries).toHaveLength(7);
    expect(entries.map((entry) => entry.textContent)).toEqual(lines.slice(-7));
    expect(activityLog?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('.tile-activity-header')?.textContent).toContain('Live activity');
    expect(host.textContent).not.toContain('zsh');
  });

  it('preserves streamed text across incremental chunks while separating complete lines', () => {
    const ws = new FakeWebSocket();
    const host = mount(ws);

    act(() => { ws.preview(session.id, 'Reviewing src/ui/workspace/'); });
    act(() => { ws.preview(session.id, 'GridView.tsx\nRunning focused tests\n'); });

    const entries = Array.from(host.querySelectorAll('.preview-entry'));
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'Reviewing src/ui/workspace/GridView.tsx',
      'Running focused tests',
    ]);
  });
});
