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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Response whose resolution the test controls, for exercising in-flight requests (a slow fetch, a Run switch before it settles). */
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => { resolve = res; });
  return { promise, resolve };
}

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

// Ticket 71 (B09, docs/specs/run-feedback-review.md): the review badge and
// the "Request changes"/"Mark reviewed" composer actions — reusing the same
// stubbed-fetch harness above, routing GET .../review and POST .../feedback
// off the request URL/method exactly like the feedback fixtures do.
describe('RunFeedbackPanel review state (ticket 71, B09)', () => {
  function fetcherFor(review: unknown, postHandler?: (text: string, reviewDecision?: string) => unknown) {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { text, reviewDecision } = JSON.parse(String(init.body)) as { text: string; reviewDecision?: string };
        return json(postHandler ? postHandler(text, reviewDecision) : entry('1', text));
      }
      if (String(url).includes('/review')) return json(review);
      return json([]);
    });
  }

  it('shows no badge while the review state is not_applicable', async () => {
    vi.stubGlobal('fetch', fetcherFor({ state: 'not_applicable' }));
    await render();

    expect(host.textContent).not.toContain('Ready to review');
    expect(host.querySelector('.run-review-badge')).toBeNull();
  });

  it('shows "Ready to review" once a Run has settled with no decision yet', async () => {
    vi.stubGlobal('fetch', fetcherFor({ state: 'ready_to_review' }));
    await render();

    expect(host.querySelector('.run-review-badge')?.textContent).toBe('Ready to review');
  });

  it('shows who reviewed or requested changes, once a decision exists', async () => {
    vi.stubGlobal('fetch', fetcherFor({ state: 'changes_requested', reviewedBy: 'Bob', reviewedAt: '2026-09-01T00:00:00.000Z' }));
    await render();

    expect(host.querySelector('.run-review-badge')?.textContent).toBe('Changes requested by Bob');
  });

  it('posts "Request changes" with the composer\'s text tagged as changes_requested, then refreshes the badge', async () => {
    const fetcher = fetcherFor(
      { state: 'ready_to_review' },
      (text) => entry('1', text, 'Admin'),
    );
    vi.stubGlobal('fetch', fetcher);
    await render();

    const textarea = host.querySelector('textarea[aria-label="Add feedback"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'please add a test');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('button.button:not(.button-primary)')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });

    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ text: 'please add a test', reviewDecision: 'changes_requested' });
    expect(host.textContent).toContain('please add a test');
    expect((host.querySelector('textarea[aria-label="Add feedback"]') as HTMLTextAreaElement).value).toBe('');
  });

  it('posts "Mark reviewed" with the composer\'s text tagged as reviewed', async () => {
    const fetcher = fetcherFor(
      { state: 'ready_to_review' },
      (text) => entry('1', text, 'Admin'),
    );
    vi.stubGlobal('fetch', fetcher);
    await render();

    const textarea = host.querySelector('textarea[aria-label="Add feedback"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'looks good');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const buttons = [...host.querySelectorAll('button')];
      const markReviewed = buttons.find((button) => button.textContent === 'Mark reviewed')!;
      markReviewed.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });

    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ text: 'looks good', reviewDecision: 'reviewed' });
  });

  it('never triggers "Request changes" or "Mark reviewed" with whitespace-only text', async () => {
    const fetcher = fetcherFor({ state: 'ready_to_review' });
    vi.stubGlobal('fetch', fetcher);
    await render();

    const buttons = [...host.querySelectorAll('button')];
    const requestChanges = buttons.find((button) => button.textContent === 'Request changes')!;
    expect(requestChanges.hasAttribute('disabled')).toBe(true);
  });
});

// Feedback reliability fixes (docs/specs/run-feedback-review.md, tickets
// #67/#71): a post that reaches the server must never be reported "Not
// sent" just because the follow-up review-badge refresh fails, loading vs.
// empty vs. failed must be distinguishable states with a retry action, a
// failed background refresh must not blank out feedback/review already on
// screen, and switching Runs mid-request must never let a stale response
// land on the wrong Run's feedback, review, or composer draft.
describe('RunFeedbackPanel reliability', () => {
  it('shows the saved comment, clears the draft, and never reports "Not sent" when the post succeeds but the review refresh fails', async () => {
    let reviewCalls = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { text } = JSON.parse(String(init.body)) as { text: string };
        return json(entry('1', text, 'Admin'));
      }
      if (String(url).includes('/review')) {
        reviewCalls += 1;
        return reviewCalls === 1 ? json({ state: 'ready_to_review' }) : json({ error: 'boom' }, 500);
      }
      return json([]);
    });
    vi.stubGlobal('fetch', fetcher);
    await render();
    expect(host.querySelector('.run-review-badge')?.textContent).toBe('Ready to review');

    await submit('looks solid');

    expect(host.textContent).toContain('looks solid');
    expect(host.textContent).not.toContain('Not sent');
    expect((host.querySelector('textarea[aria-label="Add feedback"]') as HTMLTextAreaElement).value).toBe('');
    // The comment landed; only the badge refresh is stale, and says so distinctly.
    expect(host.querySelector('.run-review-badge')?.textContent).toBe('Ready to review (may be out of date)');
  });

  it('shows a loading state before the first feedback fetch resolves, distinct from genuinely empty', async () => {
    const gate = deferredResponse();
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (
      String(url).includes('/feedback') ? gate.promise : json({ state: 'not_applicable' })
    )));
    await render();

    expect(host.textContent).toContain('Loading feedback…');
    expect(host.textContent).not.toContain('No comments yet.');

    await act(async () => {
      gate.resolve(json([]));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    expect(host.textContent).toContain('No comments yet.');
    expect(host.textContent).not.toContain('Loading feedback…');
  });

  it('shows a distinct load-failure state with a retry action, and recovers once retried', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes('/feedback')) return json({ state: 'not_applicable' });
      calls += 1;
      return calls === 1 ? json({ error: 'boom' }, 500) : json([entry('1', 'recovered')]);
    }));
    await render();

    expect(host.textContent).toContain('Couldn’t load feedback.');
    expect(host.textContent).not.toContain('No comments yet.');

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });

    expect(host.textContent).toContain('recovered');
    expect(host.textContent).not.toContain('Couldn’t load feedback.');
  });

  it('preserves existing feedback and offers a retry when a later background refresh fails, without losing content', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes('/feedback')) return json({ state: 'not_applicable' });
      calls += 1;
      if (calls === 1) return json([entry('1', 'first comment')]);
      if (calls === 2) return json({ error: 'boom' }, 500);
      return json([entry('1', 'first comment')]);
    }));
    await render();
    expect(host.textContent).toContain('first comment');

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(host.textContent).toContain('first comment');
    expect(host.textContent).toContain('Feedback may be out of date.');

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.textContent).not.toContain('Feedback may be out of date.');
    expect(host.textContent).toContain('first comment');
  });

  it('does not mix feedback or drafts between Runs when switching while an earlier Run\'s request is still pending', async () => {
    const run1Feed = deferredResponse();
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes('run-1') && target.includes('/feedback')) return run1Feed.promise;
      if (target.includes('run-2') && target.includes('/feedback')) return json([entry('9', 'from run 2')]);
      return json({ state: 'not_applicable' });
    }));
    await render('run-1');

    const draftField = host.querySelector('textarea[aria-label="Add feedback"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draftField, 'draft for run 1');
      draftField.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => root.render(<RunFeedbackPanel runId="run-2" />));
    expect(host.textContent).toContain('from run 2');
    expect((host.querySelector('textarea[aria-label="Add feedback"]') as HTMLTextAreaElement).value).toBe('');

    // Run 1's slow fetch finally resolves after the switch — it must not clobber Run 2's list.
    await act(async () => {
      run1Feed.resolve(json([entry('1', 'from run 1')]));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    expect(host.textContent).toContain('from run 2');
    expect(host.textContent).not.toContain('from run 1');
  });
});
