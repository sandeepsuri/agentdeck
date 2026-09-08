// @vitest-environment jsdom
// Ticket 67 (B07, docs/specs/run-feedback-review.md): the shared, self-
// contained RunFeedbackPanel — one component reused by both RunWorkspace.tsx
// (admin) and CollaboratorWorkspace.tsx (collaborator), the same shape
// SessionChat.tsx already established for shared Session chat. Exercised
// here directly, stubbing global fetch exactly like SessionChat.test.tsx
// does, since the component fetches and posts on its own rather than
// through props.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import { RunFeedbackPanel } from './RunFeedbackPanel.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (id: string, text: string, displayName = 'Alice') => ({
  id, taskId: 'task-1', runId: 'run-1', sequence: Number(id), postedAt: `2026-09-01T00:00:0${id}.000Z`, displayName, text,
});

async function render(runId = 'run-1') {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<RunFeedbackPanel runId={runId} />));
}

async function submit(text: string) {
  const textarea = host.querySelector('textarea[aria-label="Add feedback"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    host.querySelector('.run-feedback-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

describe('RunFeedbackPanel', () => {
  it('fetches and shows a "no comments yet" state with none posted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([])));
    await render();
    expect(host.textContent).toContain('No comments yet.');
  });

  it('lists fetched entries with author and text, oldest first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([entry('1', 'Should this touch auth too?'), entry('2', 'Good question', 'Bob')])));
    await render();
    expect(host.textContent).toContain('Alice');
    expect(host.textContent).toContain('Should this touch auth too?');
    expect(host.textContent).toContain('Bob');
    expect(host.textContent).toContain('Good question');
  });

  it('reads from this Run\'s own feedback endpoint', async () => {
    const fetcher = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => json([]));
    vi.stubGlobal('fetch', fetcher);
    await render('run-42');
    expect(String(fetcher.mock.calls[0]![0])).toContain('/api/runs/run-42/feedback');
  });

  it('posts through the composer, clears the draft, and shows the new entry', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { text } = JSON.parse(String(init.body)) as { text: string };
        return json(entry('1', text, 'Admin'), 201);
      }
      return json([]);
    });
    vi.stubGlobal('fetch', fetcher);
    await render();

    await submit('looks good');

    expect(host.textContent).toContain('looks good');
    expect(host.textContent).toContain('Admin');
    expect((host.querySelector('textarea[aria-label="Add feedback"]') as HTMLTextAreaElement).value).toBe('');
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ text: 'looks good' });
  });

  it('retains the draft and shows the error on a failed post', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST' ? json({ error: 'Network unreachable' }, 500) : json([])
    )));
    await render();

    await submit('this should stay');

    expect(host.textContent).toContain('Not sent — Network unreachable');
    expect((host.querySelector('textarea[aria-label="Add feedback"]') as HTMLTextAreaElement).value).toBe('this should stay');
  });

  it('never submits whitespace-only text', async () => {
    const fetcher = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => json([]));
    vi.stubGlobal('fetch', fetcher);
    await render();

    await submit('   ');

    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('refetches on a different Run id and clears the previous Run\'s entries immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (
      String(url).includes('run-1') ? json([entry('1', 'from run 1')]) : json([entry('2', 'from run 2')])
    )));
    await render('run-1');
    expect(host.textContent).toContain('from run 1');

    await act(async () => root.render(<RunFeedbackPanel runId="run-2" />));

    expect(host.textContent).toContain('from run 2');
    expect(host.textContent).not.toContain('from run 1');
  });

  it('renders an h3 heading when headingLevel="h3", for correct nesting inside the collaborator conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([])));
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<RunFeedbackPanel headingLevel="h3" runId="run-1" />));

    expect(host.querySelector('h3')?.textContent).toBe('Feedback');
    expect(host.querySelector('h2')).toBeNull();
  });
});
