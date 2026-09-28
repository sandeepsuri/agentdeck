// @vitest-environment jsdom
// Issues #88 and #89: connect Gmail, confirm the found email from its
// context, edit the reply draft as durable versions, and approve exactly one
// saved version to send, seeing each send state.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmailAccountView, EmailMessageContext, EmailTaskView, ReplySendView } from '../../personal-tasks/email/types.js';
import { EmailRepliesPanel } from './EmailRepliesPanel.js';

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

const account: EmailAccountView = { id: 'a1', provider: 'gmail', address: 'owner@gmail.com', createdAt: '2026-09-28T10:00:00.000Z', state: 'ready' };

const lease: EmailMessageContext = {
  id: 'gm-lease', threadId: 't1', from: 'Pat Landlord <pat@example.test>', replyTo: 'office@example.test', to: ['owner@gmail.com'], cc: [],
  date: 'Mon, 21 Sep 2026 09:00:00 +0000', subject: 'Lease renewal', excerpt: 'Can you confirm you will sign by Friday?', excerptTruncated: false,
};
const news: EmailMessageContext = { ...lease, id: 'gm-news', from: 'news@example.test', subject: 'Weekly', excerpt: 'Tips', replyTo: undefined } as EmailMessageContext;

function task(overrides: Partial<EmailTaskView> = {}): EmailTaskView {
  return {
    id: 't1', title: 'Find: Pat lease', status: 'completed', workspace: 'owner', policyVersion: 'personal-email/1', request: 'Pat lease; say yes',
    account: { id: 'a1', address: 'owner@gmail.com', revoked: false }, submittedAt: '2026-09-28T10:01:00.000Z', updatedAt: '2026-09-28T10:01:00.000Z',
    submittedBy: { displayName: 'owner', device: 'This Mac' }, attempts: [],
    activity: [{ sequence: 1, at: '2026-09-28T10:01:00.000Z', kind: 'proposal-ready', message: 'Found 2 possible emails.' }],
    result: {
      kind: 'email-reply-proposal', attemptId: 'x', completedAt: '2026-09-28T10:01:00.000Z',
      provider: { runtime: 'claude', cliVersion: '2.1.283', confinement: 'macos-seatbelt' },
      candidates: [news, lease], proposedMessageId: 'gm-lease', suggestedBody: 'Yes, by Friday.',
    },
    drafts: [],
    sends: [],
    ...overrides,
  };
}

const DIGEST = 'ab'.repeat(32);
const sendOf = (state: ReplySendView['state'], reason?: string): ReplySendView => ({
  sendId: 's1', draftVersion: 1, digest: DIGEST, state, approvedAt: '2026-09-28T10:03:00.000Z', approvedBy: { displayName: 'owner', device: 'This Mac' },
  expiresAt: '2026-09-28T10:13:00.000Z', content: { to: ['office@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'Yes, by Friday.', attachments: [] },
  ...(state === 'sent' ? { settledAt: '2026-09-28T10:03:02.000Z' } : {}), ...(reason ? { reason } : {}),
});

const confirmedTask = () => task({
  title: 'Reply to “Lease renewal”', confirmed: lease, confirmedBy: { displayName: 'owner', device: 'This Mac' },
  drafts: [{
    version: 1, state: 'saved', origin: 'agentdeck', digest: 'ab'.repeat(32), createdAt: '2026-09-28T10:02:00.000Z', updatedAt: '2026-09-28T10:02:00.000Z',
    createdBy: { displayName: 'owner', device: 'This Mac' },
    content: { to: ['office@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'Yes, by Friday.', attachments: [] },
  }],
});

function stub(state: { accounts: EmailAccountView[]; tasks: EmailTaskView[] }) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/confirm')) state.tasks = [confirmedTask()];
      return json(state.tasks[0] ?? {});
    }
    if (url === '/api/personal/email/accounts') return json(state.accounts);
    if (url === '/api/personal/email/tasks') return json(state.tasks);
    return json({ error: 'not found' }, 404);
  }));
  return posts;
}

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<EmailRepliesPanel />));
  await flush();
}

const button = (label: string) => [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label))!;
async function click(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EmailRepliesPanel', () => {
  it('shows a repair state for an account that needs reconnecting', async () => {
    stub({ accounts: [{ ...account, state: 'signed-out', repair: 'Reconnect Gmail: the sign-in expired.' }], tasks: [] });
    await render();
    expect(host.textContent).toContain('Signed out — Reconnect Gmail: the sign-in expired.');
    expect(button('Connect Gmail')).toBeDefined();
  });

  it('shows the suggested match with its sender, subject, and text, and confirms it', async () => {
    const posts = stub({ accounts: [account], tasks: [task()] });
    await render();
    const card = host.querySelector('.email-candidates .email-message')!;
    expect(card.textContent).toContain('Pat Landlord <pat@example.test>');
    expect(card.textContent).toContain('Lease renewal');
    expect(card.textContent).toContain('Can you confirm you will sign by Friday?');
    expect(card.textContent).toContain('Replies go to office@example.test');
    await click(button('This is the email'));
    expect(posts).toEqual([{ url: '/api/personal/email/tasks/t1/confirm', body: { messageId: 'gm-lease' } }]);
    expect(host.querySelector('[aria-label="Exactly what Gmail holds"]')?.textContent).toContain('office@example.test');
  });

  it('saves an edit on top of the version shown, and will not approve unsaved edits', async () => {
    const posts = stub({ accounts: [account], tasks: [confirmedTask()] });
    await render();
    const exact = host.querySelector('[aria-label="Exactly what Gmail holds"]')!;
    expect(exact.textContent).toContain('Saved in Gmail');
    expect(exact.textContent).toContain('Yes, by Friday.');
    expect(exact.textContent).toContain('Attachments');
    const [toField, ccField, , bodyField] = [...host.querySelectorAll('.email-draft textarea, .email-draft input')] as HTMLTextAreaElement[];
    await act(async () => {
      type(toField!, 'office@example.test\n"Doe, Jane" <jane@example.test>');
      type(ccField!, '');
      type(bodyField!, 'Yes, by Thursday.');
    });
    expect(button('Approve and send').disabled).toBe(true);
    expect(host.querySelector('.email-send')?.textContent).toContain('edits that are not saved');
    await click(button('Save draft'));
    expect(posts.at(-1)).toEqual({
      url: '/api/personal/email/tasks/t1/draft',
      body: { baseVersion: 1, to: ['office@example.test', '"Doe, Jane" <jane@example.test>'], cc: [], subject: 'Re: Lease renewal', body: 'Yes, by Thursday.' },
    });
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(false);
  });

  it('shows every recipient, the subject, body, and attachments, and approves that exact version', async () => {
    const withCc = confirmedTask();
    withCc.drafts[0]!.content = { ...withCc.drafts[0]!.content, cc: ['partner@example.test'] };
    const posts = stub({ accounts: [account], tasks: [withCc] });
    await render();
    const exact = host.querySelector('[aria-label="Exactly what Gmail holds"]')!.textContent!;
    for (const part of ['office@example.test', 'partner@example.test', 'Re: Lease renewal', 'Yes, by Friday.', 'Attachments', 'None']) expect(exact).toContain(part);
    expect(host.querySelector('.email-send')?.textContent).toContain('to office@example.test, partner@example.test — once, from owner@gmail.com');
    await click(button('Approve and send version 1'));
    expect(posts).toEqual([{ url: '/api/personal/email/tasks/t1/send', body: { version: 1, digest: DIGEST } }]);
  });

  it('will not offer approval for a draft with attachments added in Gmail', async () => {
    const withFile = confirmedTask();
    withFile.drafts[0]!.content = { ...withFile.drafts[0]!.content, attachments: [{ name: 'lease.pdf', mimeType: 'application/pdf', size: 10 }] };
    stub({ accounts: [account], tasks: [withFile] });
    await render();
    expect(host.textContent).toContain('lease.pdf (10 B)');
    expect(button('Approve and send').disabled).toBe(true);
    expect(host.querySelector('.email-send')?.textContent).toContain('cannot send exactly');
  });

  it.each([
    ['sending', 'Sending…'],
    ['sent', 'Sent'],
    ['ambiguous', 'Not confirmed — checking Gmail'],
  ] as const)('shows a %s send in place of the editor and approval', async (state, label) => {
    stub({ accounts: [account], tasks: [{ ...confirmedTask(), sends: [sendOf(state, state === 'ambiguous' ? 'Gmail did not confirm the send.' : undefined)] }] });
    await render();
    const card = host.querySelector('.email-send')!;
    expect(card.querySelector('h4')?.textContent).toBe(label);
    expect(card.textContent).toContain('to office@example.test, approved by owner on This Mac');
    expect(card.querySelector('[aria-label="What was approved"]')?.textContent).toContain('Re: Lease renewal');
    expect(card.querySelector('.email-body')?.textContent).toBe('Yes, by Friday.');
    expect(host.querySelector('.email-draft .email-form')).toBeNull();
    expect([...host.querySelectorAll('button')].some((entry) => entry.textContent?.includes('Approve and send'))).toBe(false);
    expect(Boolean(card.querySelector('button')?.textContent?.includes('Check Gmail'))).toBe(state === 'ambiguous');
    if (state === 'ambiguous') expect(card.textContent).toContain('Gmail did not confirm the send.');
  });

  it('after a failed send, shows why and lets the owner approve again', async () => {
    const posts = stub({ accounts: [account], tasks: [{ ...confirmedTask(), sends: [sendOf('failed', 'Gmail refused POST /messages/send (400). Nothing was sent.')] }] });
    await render();
    expect(host.querySelector('.email-send')?.textContent).toContain('Last approval: Not sent. Gmail refused');
    await click(button('Approve and send version 1'));
    expect(posts.at(-1)).toEqual({ url: '/api/personal/email/tasks/t1/send', body: { version: 1, digest: DIGEST } });
  });
});
