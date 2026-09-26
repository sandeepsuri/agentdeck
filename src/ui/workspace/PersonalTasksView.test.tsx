// @vitest-environment jsdom
// Issue #80: the owner's personal-task view — grant a folder through the
// server-side picker, choose PDFs, submit, and read activity and results from
// the durable projection. fetch is stubbed per route.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FolderGrantView, PersonalTaskView } from '../../personal-tasks/types.js';
import { PersonalTasksView } from './PersonalTasksView.js';

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

const grant: FolderGrantView = { id: 'g1', name: 'Statements', displayPath: '~/Documents/Statements', createdAt: '2026-09-25T10:00:00.000Z' };

function task(overrides: Partial<PersonalTaskView> = {}): PersonalTaskView {
  return {
    id: 't1', kind: 'pdf-inventory', title: 'Inspect 1 PDF in Statements', status: 'completed', workspace: 'owner',
    policyVersion: 'personal-files/1', grant: { id: 'g1', name: 'Statements', revoked: false }, files: ['march.pdf'],
    submittedAt: '2026-09-25T10:01:00.000Z', updatedAt: '2026-09-25T10:01:01.000Z',
    submittedBy: { displayName: 'owner', device: 'This Mac' },
    attempts: [{ id: 'a1', sequence: 1, startedAt: '2026-09-25T10:01:00.000Z', endedAt: '2026-09-25T10:01:01.000Z', outcome: 'completed' }],
    activity: [
      { sequence: 1, at: '2026-09-25T10:01:00.000Z', kind: 'submitted', message: 'owner asked to inspect 1 PDF on This Mac.' },
      { sequence: 2, at: '2026-09-25T10:01:00.000Z', kind: 'attempt-started', message: 'Inspecting 1 PDF.' },
      { sequence: 3, at: '2026-09-25T10:01:01.000Z', kind: 'file-inspected', message: 'Inspected march.pdf.', path: 'march.pdf' },
      { sequence: 4, at: '2026-09-25T10:01:01.000Z', kind: 'completed', message: 'Inventoried 1 PDF.' },
    ],
    result: {
      attemptId: 'a1', completedAt: '2026-09-25T10:01:01.000Z', totalBytes: 2048, knownPages: 4, skipped: [],
      files: [{ path: 'march.pdf', name: 'march.pdf', size: 2048, modifiedAt: '2026-09-01T00:00:00.000Z', sha256: 'ab'.repeat(32), pdfVersion: '1.7', pageCount: 4, encrypted: false }],
    },
    ...overrides,
  };
}

interface Server {
  grants: FolderGrantView[];
  tasks: PersonalTaskView[];
  posts: { url: string; body: unknown }[];
}

function stubServer(server: Server) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      server.posts.push({ url, body });
      if (url === '/api/personal/grants/pick') {
        server.grants = [grant];
        return json({ grant }, 201);
      }
      if (url === '/api/personal/tasks') {
        const created = task({ status: 'queued', activity: [], attempts: [] });
        delete created.result;
        server.tasks = [created];
        return json(created, 201);
      }
      if (url.endsWith('/revoke')) {
        server.grants = [{ ...grant, revokedAt: '2026-09-25T11:00:00.000Z' }];
        return json({ grant: server.grants[0] });
      }
      if (url.endsWith('/retry')) return json(server.tasks[0]);
    }
    if (url === '/api/personal/grants') return json(server.grants);
    if (url === '/api/personal/tasks') return json(server.tasks);
    if (url === '/api/personal/grants/g1/pdfs') {
      return json({ files: [{ relativePath: 'march.pdf', size: 2048, modifiedAt: '' }, { relativePath: 'april.pdf', size: 10, modifiedAt: '' }], truncated: false });
    }
    return json({ error: 'not found' }, 404);
  }));
}

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PersonalTasksView />));
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

describe('PersonalTasksView', () => {
  it('shows honest empty states', async () => {
    stubServer({ grants: [], tasks: [], posts: [] });
    await render();
    expect(host.textContent).toContain('No folders yet');
    expect(host.textContent).toContain('No personal tasks yet');
  });

  it('grants a picked folder, submits only the selected PDFs, and shows the queued task', async () => {
    const server: Server = { grants: [], tasks: [], posts: [] };
    stubServer(server);
    await render();
    await click(button('Choose a folder'));
    await flush();
    expect(host.textContent).toContain('~/Documents/Statements');
    expect(host.querySelectorAll('.personal-pdf-picker li input[type="checkbox"]')).toHaveLength(2);

    const april = [...host.querySelectorAll('.personal-pdf-picker li label')].find((label) => label.textContent?.includes('april.pdf'))!;
    await click(april.querySelector('input')!);
    await click(button('Inspect 1 PDF'));
    await flush();
    expect(server.posts.at(-1)).toEqual({ url: '/api/personal/tasks', body: { kind: 'pdf-inventory', grantId: 'g1', files: ['march.pdf'] } });
    expect(host.querySelector('.personal-task-detail .personal-status')?.textContent).toBe('Queued');
  });

  it('shows who asked, the ordered activity, and the inventory result', async () => {
    stubServer({ grants: [grant], tasks: [task()], posts: [] });
    await render();
    const detail = host.querySelector('.personal-task-detail')!;
    expect(detail.textContent).toContain('owner on This Mac');
    expect(detail.textContent).toContain('personal-files/1');
    expect([...detail.querySelectorAll('.personal-activity li span')].map((item) => item.textContent)).toEqual([
      'owner asked to inspect 1 PDF on This Mac.', 'Inspecting 1 PDF.', 'Inspected march.pdf.', 'Inventoried 1 PDF.',
    ]);
    expect(detail.querySelector('tbody tr')?.textContent).toContain('march.pdf');
    expect(detail.querySelector('.personal-result-summary')?.textContent).toContain('4 pages');
  });

  it('revokes a folder grant', async () => {
    const server: Server = { grants: [grant], tasks: [], posts: [] };
    stubServer(server);
    await render();
    await click(button('Revoke access to Statements'));
    await flush();
    expect(server.posts.map((entry) => entry.url)).toEqual(['/api/personal/grants/g1/revoke']);
    expect(host.textContent).toContain('Access revoked');
  });

  it('explains a failed task and offers to try again', async () => {
    const failed = task({ status: 'failed', failure: 'Access to the folder was revoked. No further files were read.' });
    delete failed.result;
    const server: Server = { grants: [grant], tasks: [failed], posts: [] };
    stubServer(server);
    await render();
    expect(host.querySelector('.personal-failure')?.textContent).toContain('revoked');
    await click(button('Try again'));
    expect(server.posts.map((entry) => entry.url)).toEqual(['/api/personal/tasks/t1/retry']);
  });

  it('shows an error state when the service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Personal tasks are only available to the owner on this Mac.' }, 403)));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('only available to the owner');
  });
});
