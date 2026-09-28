import { describe, expect, it } from 'vitest';
import { GmailMailbox, MailboxError } from './gmail.js';
import { GMAIL_SCOPES } from './gmail-oauth.js';
import { validateReplyContent } from './reply.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { method: string; url: string; body?: unknown }

function fakeGmail(routes: (call: Call) => Response | undefined, token: Record<string, unknown> = { access_token: 'at', expires_in: 3600, scope: GMAIL_SCOPES.join(' ') }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { method: init?.method ?? 'GET', url, ...(init?.body ? { body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : String(init.body) } : {}) };
    calls.push(call);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return 'error' in token ? json(400, token) : json(200, token);
    return routes(call) ?? json(404, { error: { code: 404 } });
  }) as typeof fetch;
  const mailbox = new GmailMailbox({
    client: { clientId: 'cid', clientSecret: 'secret' }, refreshToken: 'rt', address: 'owner@gmail.com', fetch: fetchImpl,
  });
  return { mailbox, calls };
}

const MESSAGE = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'Please confirm',
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'Pat <pat@example.test>' }, { name: 'Reply-To', value: 'office@example.test' },
      { name: 'To', value: 'owner@gmail.com' }, { name: 'Subject', value: 'Lease renewal' }, { name: 'Date', value: 'Mon, 1 Sep 2026 09:00:00 +0000' },
      { name: 'Message-ID', value: '<abc@example.test>' }, { name: 'References', value: '<older@example.test>' },
    ],
    body: { data: b64('Please confirm by Friday. '.repeat(10)) },
  },
};

describe('GmailMailbox', () => {
  it('searches the one account, skipping drafts, and reads a message for context', async () => {
    const { mailbox, calls } = fakeGmail((call) => {
      if (call.url.includes('/messages?')) return json(200, { messages: [{ id: 'm1' }, { id: 'd1' }] });
      if (call.url.includes('/messages/m1?format=metadata')) return json(200, MESSAGE);
      if (call.url.includes('/messages/d1?format=metadata')) return json(200, { ...MESSAGE, id: 'd1', labelIds: ['DRAFT'] });
      if (call.url.includes('/messages/m1?format=full')) return json(200, MESSAGE);
      return undefined;
    });
    const found = await mailbox.search('from:pat lease', 5);
    expect(found).toEqual([{ id: 'm1', threadId: 't1', from: 'Pat <pat@example.test>', subject: 'Lease renewal', date: 'Mon, 1 Sep 2026 09:00:00 +0000', snippet: 'Please confirm' }]);
    const query = new URL(calls.find((call) => call.url.includes('/messages?'))!.url).searchParams;
    expect(query.get('q')).toBe('from:pat lease');
    expect(query.get('maxResults')).toBe('5');

    const context = await mailbox.message('m1', 40);
    expect(context).toMatchObject({
      id: 'm1', threadId: 't1', from: 'Pat <pat@example.test>', replyTo: 'office@example.test', to: ['owner@gmail.com'], cc: [],
      subject: 'Lease renewal', messageIdHeader: '<abc@example.test>', references: '<older@example.test>', excerptTruncated: true,
    });
    expect(context.excerpt).toHaveLength(40);
    expect(calls.every((call) => call.url.startsWith('https://oauth2.googleapis.com/') || call.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/'))).toBe(true);
  });

  it('creates, updates, reads back, and finds a draft by intent without ever sending', async () => {
    const drafts = new Map<string, { raw: string; threadId: string }>();
    const { mailbox, calls } = fakeGmail((call) => {
      const body = call.body as { message?: { raw: string; threadId: string } } | undefined;
      if (call.method === 'POST' && call.url.endsWith('/drafts')) {
        drafts.set('r1', body!.message!);
        return json(200, { id: 'r1', message: { id: 'x', threadId: 't1' } });
      }
      if (call.method === 'PUT' && call.url.endsWith('/drafts/r1')) {
        drafts.set('r1', body!.message!);
        return json(200, { id: 'r1' });
      }
      if (call.method === 'GET' && call.url.includes('/drafts/r1?')) {
        const raw = Buffer.from(drafts.get('r1')!.raw, 'base64url').toString('utf8');
        const head = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n').map((line) => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 2) }));
        const data = Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('base64url');
        return json(200, { id: 'r1', message: { id: 'x', threadId: 't1', payload: { mimeType: 'text/plain', headers: head, body: { data } } } });
      }
      if (call.method === 'GET' && call.url.includes('/drafts?')) return json(200, { drafts: [{ id: 'other', message: { threadId: 't9' } }, { id: 'r1', message: { threadId: 't1' } }] });
      return undefined;
    });
    const content = validateReplyContent({ to: ['office@example.test'], cc: [], subject: 'Re: Lease renewal', body: 'Yes, by Friday.' });
    const reply = { content, threadId: 't1', inReplyTo: '<abc@example.test>', references: '<older@example.test> <abc@example.test>', intentId: 'i1', messageId: '<i1@agentdeck.local>' };
    const id = await mailbox.createDraft(reply);
    expect(id).toBe('r1');
    await mailbox.updateDraft(id, { ...reply, content: { ...content, body: 'Yes, by Thursday.' } });
    const read = await mailbox.readDraft(id);
    expect(read).toEqual({ content: { ...content, body: 'Yes, by Thursday.' }, intentId: 'i1' });
    expect(await mailbox.findDraftByIntent('i1', 't1')).toBe('r1');
    expect(await mailbox.findDraftByIntent('nope', 't1')).toBeUndefined();
    expect(calls.some((call) => /\/send\b|\/messages\/send|\/drafts\/send/.test(call.url))).toBe(false);
    expect(Object.getOwnPropertyNames(GmailMailbox.prototype).filter((name) => /send/i.test(name))).toEqual([]);
  });

  it('reports a draft that no longer exists as missing', async () => {
    const { mailbox } = fakeGmail(() => json(404, { error: { code: 404 } }));
    expect(await mailbox.readDraft('gone')).toBeNull();
  });

  it.each([
    ['an expired or revoked sign-in', { error: 'invalid_grant' }, 'signed-out'],
    ['a rejected client', { error: 'invalid_client' }, 'no-client'],
    ['a consent without the compose scope', { access_token: 'at', expires_in: 3600, scope: GMAIL_SCOPES[0] }, 'missing-scope'],
  ])('turns %s into a repair state', async (_label, token, code) => {
    const { mailbox } = fakeGmail(() => json(200, { emailAddress: 'owner@gmail.com' }), token);
    await expect(mailbox.profile()).rejects.toMatchObject({ code });
  });

  it.each([
    [401, 'signed-out'], [403, 'missing-scope'], [429, 'unreachable'], [503, 'unreachable'], [400, 'rejected'],
  ])('maps HTTP %i from Gmail to %s', async (status, code) => {
    const { mailbox } = fakeGmail(() => json(status, { error: { code: status, status: status === 403 ? 'PERMISSION_DENIED' : 'X' } }));
    const error = await mailbox.search('x', 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxError);
    expect((error as MailboxError).code).toBe(code);
  });

  it('treats a network failure as unreachable', async () => {
    const mailbox = new GmailMailbox({
      client: { clientId: 'c', clientSecret: 's' }, refreshToken: 'rt', address: 'owner@gmail.com',
      fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    });
    await expect(mailbox.profile()).rejects.toMatchObject({ code: 'unreachable' });
  });
});
