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
      <InspectorRail onAction={() => undefined} onError={onError} onRename={() => undefined} selected={session} />
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

describe('InspectorRail live status', () => {
  const claudeSession: Session = { ...firstSession, agent: 'claude', branch: 'feat/simplify-product' };
  const plan = [
    { label: 'Read probe script', status: 'completed' },
    { label: 'Update checklist', activeForm: 'Updating checklist', status: 'in_progress' },
    { label: 'Run tests', status: 'pending' },
  ];
  const turns = [{ id: 't1', role: 'tool', toolName: 'Bash', text: 'npm test -- --confinement', ts: '2026-09-27T17:20:00Z' }];

  async function renderWith(conversation: object, onOpenView = vi.fn()) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/conversation')) return new Response(JSON.stringify(conversation));
      if (String(url).includes('/api/repos/diff')) return new Response(JSON.stringify({ files: [{ path: 'src/a.ts', additions: 48, deletions: 12 }, { path: 'src/b.ts', additions: 34, deletions: 9 }] }));
      return new Response('[]');
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <InspectorRail onAction={() => undefined} onError={() => undefined} onOpenView={onOpenView} onRename={() => undefined} selected={claudeSession} />,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return onOpenView;
  }

  it('shows the current command, checklist progress and changes while working', async () => {
    await renderWith({ found: true, turns, plan });
    const rail = host.querySelector('.inspector-rail')!;
    expect(rail.classList.contains('is-live-working')).toBe(true);
    expect(rail.querySelector('.inspector-subtitle')?.textContent).toBe('Updating checklist');
    expect(rail.querySelector('.inspector-now')?.textContent).toContain('Running test suite');
    expect(rail.querySelector('.inspector-count')?.textContent).toBe('1/3');
    expect([...rail.querySelectorAll('.inspector-step')].map((step) => step.className)).toEqual([
      'inspector-step is-completed', 'inspector-step is-in_progress', 'inspector-step is-pending',
    ]);
    expect(rail.querySelector('.inspector-changes')?.textContent).toContain('2 files changed+82−21');
    expect(rail.querySelector('.inspector-needs-input')).toBeNull();
  });

  it('turns an open question into a Needs input card that stops the working animation and opens the Conversation', async () => {
    const onOpenView = await renderWith({
      found: true, turns, plan,
      question: { id: 'q1', delivery: 'menu', questions: [{ question: 'Which Gmail client setup?', multiSelect: false, options: [] }] },
    });
    const rail = host.querySelector('.inspector-rail')!;
    expect(rail.classList.contains('is-live-working')).toBe(false);
    expect(rail.querySelector('.inspector-status-pill')?.textContent).toBe('Needs input');
    expect(rail.querySelector('.inspector-needs-input')?.textContent).toContain('Which Gmail client setup?');
    await act(async () => { rail.querySelector<HTMLButtonElement>('.inspector-needs-primary')!.click(); });
    expect(onOpenView).toHaveBeenCalledWith('conversation', undefined);
  });
});

describe('InspectorRail message draft lifecycle', () => {
  it('keeps a Session draft across unrelated navigation, but isolates Sessions and stale sends', async () => {
    let finishFirstSend!: (response: Response) => void;
    // Only the /send request is held for the test to settle; the panel's own polls never answer.
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { if (String(url).endsWith('/send')) finishFirstSend = resolve; })));
    const onError = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="work" />));
    setDraft('message for session one');

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="home" />));
    expect(host.querySelector('.inspector-dock')?.hasAttribute('hidden')).toBe(true);

    await act(async () => root.render(<InspectorDock onError={onError} session={firstSession} view="work" />));
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('message for session one');

    await act(async () => { host.querySelector<HTMLButtonElement>('.rail-message-box button')!.click(); });
    await act(async () => root.render(<InspectorDock onError={onError} session={secondSession} view="work" />));
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('');

    await act(async () => {
      finishFirstSend(new Response(JSON.stringify({ error: 'late failure' }), { status: 500 }));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.rail-message-box input')?.value).toBe('');
  });
});
