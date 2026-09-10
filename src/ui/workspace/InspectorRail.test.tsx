// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import { isInspectorRelevant } from '../navigation.js';
import { InspectorRail } from './InspectorRail.js';
import type { WorkspaceView } from './model.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root;
let host: HTMLDivElement;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  vi.unstubAllGlobals();
});

const firstSession: Session = {
  id: 'session-1', origin: 'managed', agent: 'codex', name: 'First session', cwd: '/repos/first',
  status: 'working', statusSource: 'hook', startedAt: '2026-09-01T00:00:00Z', lastActivityAt: '2026-09-01T00:01:00Z',
};
const secondSession: Session = { ...firstSession, id: 'session-2', name: 'Second session', cwd: '/repos/second' };

function InspectorDock({ view, session, onError }: { view: WorkspaceView; session: Session; onError: (message: string) => void }) {
  return (
    <div className="inspector-dock" hidden={!isInspectorRelevant(view, true)}>
      <InspectorRail conflicts={[]} events={[]} onAction={() => undefined} onError={onError} onRename={() => undefined} onView={() => undefined} selected={session} view={view} />
    </div>
  );
}

function setDraft(value: string) {
  const input = host.querySelector<HTMLInputElement>('.rail-message-box input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('InspectorRail message draft lifecycle', () => {
  it('keeps a Session draft across unrelated navigation, but isolates Sessions and stale sends', async () => {
    let finishFirstSend!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finishFirstSend = resolve; })));
    const onError = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="operations" />));
    setDraft('message for session one');

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="overview" />));
    expect(host.querySelector('.inspector-dock')?.hasAttribute('hidden')).toBe(true);

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="operations" />));
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('message for session one');

    await act(async () => { host.querySelector<HTMLButtonElement>('.rail-message-box button')!.click(); });
    await act(async () => root.render(<InspectorDock onError={onError} session={secondSession} view="operations" />));
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('');

    await act(async () => {
      finishFirstSend(new Response(JSON.stringify({ error: 'late failure' }), { status: 500 }));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('');
  });
});
