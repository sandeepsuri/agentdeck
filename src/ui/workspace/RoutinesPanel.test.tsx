// @vitest-environment jsdom
// Issue #92: the Routines panel — run a saved routine again, open the task a
// run started, see why a run did not start, point a routine whose folder was
// revoked at a folder chosen again, and save a task that worked as a routine.
// fetch is stubbed per route.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoutineView } from '../../personal-tasks/routines/types.js';
import type { FolderGrantView } from '../../personal-tasks/types.js';
import { RoutinesPanel, SaveRoutine } from './RoutinesPanel.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

const grants: FolderGrantView[] = [
  { id: 'g1', name: 'Inbox', displayPath: '~/Documents/Inbox', createdAt: '2026-09-25T10:00:00.000Z', revokedAt: '2026-09-29T10:00:00.000Z' },
  { id: 'g2', name: 'Inbox', displayPath: '~/Documents/Inbox', createdAt: '2026-09-29T11:00:00.000Z' },
];

function routine(overrides: Partial<RoutineView> = {}): RoutineView {
  return {
    id: 'r1', name: 'File new bills', kind: 'pdf-filing-proposal', target: { id: 'g2', label: 'Inbox', revoked: false },
    createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z',
    runs: [
      { id: 'run-2', sequence: 2, at: '2026-09-29T10:30:00.000Z', by: { displayName: 'owner', device: 'This Mac' }, outcome: 'blocked', block: { code: 'folder-revoked', message: 'Access to Inbox was revoked.' } },
      { id: 'run-1', sequence: 1, at: '2026-09-28T10:00:00.000Z', by: { displayName: 'owner', device: 'This Mac' }, outcome: 'started', task: { source: 'personal', id: 't1', title: 'Propose filing for 1 PDF in Inbox', status: 'completed' } },
    ],
    ...overrides,
  };
}

function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => { root.render(node); });
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label) || entry.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function stub(routes: (method: string, url: string, body: unknown) => Response | undefined) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method, url, body });
    return routes(method, url, body) ?? json({ error: 'not found' }, 404);
  }));
  return calls;
}

describe('RoutinesPanel', () => {
  it('lists runs, opens the task a run started, and runs the routine again', async () => {
    let current = routine();
    const calls = stub((method, url) => {
      if (url === '/api/personal/routines' && method === 'GET') return json([current]);
      if (url === '/api/personal/grants') return json(grants);
      if (url === '/api/personal/routines/r1/run') {
        const run = { id: 'run-3', sequence: 3, at: '2026-09-30T09:00:00.000Z', by: { displayName: 'owner', device: 'This Mac' }, outcome: 'started' as const, task: { source: 'personal' as const, id: 't3', title: 'Propose filing for 2 PDFs in Inbox', status: 'queued' as const } };
        current = { ...current, runs: [run, ...current.runs] };
        return json({ run, routine: current });
      }
      return undefined;
    });
    const opened: string[] = [];
    const ran: string[] = [];
    await render(<RoutinesPanel onOpenTask={(source, id) => opened.push(`${source}:${id}`)} onRan={(source) => ran.push(source)} />);
    await flush();

    expect(host.textContent).toContain('File new bills');
    expect(host.textContent).toContain('Filing plan for new PDFs · Inbox');
    expect(host.textContent).toContain('Did not start: Access to Inbox was revoked.');
    await act(async () => { button('Propose filing for 1 PDF in Inbox').click(); });
    expect(opened).toEqual(['personal:t1']);

    await act(async () => { button('Run again').click(); });
    await flush();
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/personal/routines/r1/run')).toBe(true);
    expect(ran).toEqual(['personal']);
    expect(opened).toEqual(['personal:t1', 'personal:t3']);
    // The new run is still starting, so the routine cannot be run a second time.
    expect(button('Run again').disabled).toBe(true);
    expect(host.textContent).toContain('Queued');
  });

  it('shows the repair for a revoked folder and points the routine at the folder chosen again', async () => {
    let current = routine({ target: { id: 'g1', label: 'Inbox', revoked: true }, repair: { code: 'folder-revoked', message: 'Access to Inbox was revoked. Choose the folder again.' } });
    const calls = stub((method, url) => {
      if (url === '/api/personal/routines' && method === 'GET') return json([current]);
      if (url === '/api/personal/grants') return json(grants);
      if (url === '/api/personal/routines/r1' && method === 'PATCH') {
        current = routine();
        return json(current);
      }
      return undefined;
    });
    await render(<RoutinesPanel />);
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Access to Inbox was revoked.');
    expect(button('Run again').disabled).toBe(true);
    const select = host.querySelector('select')!;
    expect([...select.options].map((option) => option.value)).toEqual(['g2']);
    await act(async () => { button('Use this folder').click(); });
    await flush();
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ grantId: 'g2' });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('Run again').disabled).toBe(false);
  });

  it('says to choose the folder again when there is none to use yet, and deletes a routine', async () => {
    let list = [routine({ target: { id: 'g1', label: 'Inbox', revoked: true }, repair: { code: 'folder-revoked', message: 'Access to Inbox was revoked.' } })];
    const calls = stub((method, url) => {
      if (url === '/api/personal/routines' && method === 'GET') return json(list);
      if (url === '/api/personal/grants') return json([grants[0]]);
      if (url === '/api/personal/routines/r1' && method === 'DELETE') {
        list = [];
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    await render(<RoutinesPanel />);
    await flush();
    expect(host.textContent).toContain('Choose the folder again under Folders');
    await act(async () => { button('Delete routine File new bills').click(); });
    await flush();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(host.textContent).toContain('No routines yet.');
  });

  it('stays out of the way when routines are unavailable', async () => {
    stub(() => json({ error: 'Routines are only available to the owner on this Mac.' }, 403));
    await render(<RoutinesPanel />);
    await flush();
    expect(host.textContent).toBe('');
  });
});

describe('SaveRoutine', () => {
  it('names and saves the task as a routine', async () => {
    const calls = stub((method, url) => (method === 'POST' && url === '/api/personal/routines' ? json(routine({ name: 'Answer Pat', runs: [] }), 201) : undefined));
    const saved: string[] = [];
    await render(<SaveRoutine defaultName="Reply to Pat" onSaved={(entry) => saved.push(entry.id)} source="email" taskId="e1" />);
    await act(async () => { button('Save as routine').click(); });
    const input = host.querySelector('input')!;
    expect(input.value).toBe('Reply to Pat');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Answer Pat');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Save').click(); });
    await flush();
    expect(calls[0]).toMatchObject({ method: 'POST', body: { name: 'Answer Pat', source: 'email', taskId: 'e1' } });
    expect(saved).toEqual(['r1']);
    expect(host.textContent).toContain('Saved “Answer Pat” to Routines.');
  });
});
