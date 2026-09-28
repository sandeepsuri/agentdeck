import { describe, expect, it } from 'vitest';
import {
  buildReplyMime, draftDigest, parseAddressList, readGmailPayload, replyFor, ReplyContentError, validateReplyContent, type GmailPayload,
} from './reply.js';
import type { EmailMessageContext } from './types.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

const CONTEXT: EmailMessageContext = {
  id: 'm1',
  threadId: 't1',
  from: 'Pat Landlord <pat@example.test>',
  to: ['owner@gmail.com'],
  cc: ['agent@example.test'],
  subject: 'Lease renewal',
  messageIdHeader: '<abc@example.test>',
  references: '<older@example.test>',
  excerpt: 'Please confirm by Friday.',
  excerptTruncated: false,
};

describe('parseAddressList', () => {
  it('splits on commas outside quoted names', () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.test>, bob@example.test')).toEqual(['"Doe, Jane" <jane@example.test>', 'bob@example.test']);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('replyFor', () => {
  it('answers the sender with a Re: subject and no one else', () => {
    expect(replyFor(CONTEXT)).toEqual({ to: ['Pat Landlord <pat@example.test>'], cc: [], subject: 'Re: Lease renewal' });
  });

  it('uses Reply-To when the message names one, and keeps an existing Re:', () => {
    expect(replyFor({ ...CONTEXT, replyTo: 'office@example.test', subject: 'RE: Lease renewal' }))
      .toEqual({ to: ['office@example.test'], cc: [], subject: 'RE: Lease renewal' });
  });
});

describe('validateReplyContent', () => {
  const base = { to: ['pat@example.test'], cc: [], subject: 'Re: Lease', body: 'Yes, I will sign by Friday.' };

  it('normalises exact recipients, subject, and body', () => {
    expect(validateReplyContent({ ...base, to: [' Pat <pat@example.test> '], body: 'Line 1\r\nLine 2' })).toEqual({
      to: ['Pat <pat@example.test>'], cc: [], subject: 'Re: Lease', body: 'Line 1\nLine 2', attachments: [],
    });
  });

  it.each([
    [{ to: [] }, /at least one recipient/],
    [{ to: ['not an address'] }, /not an email address/],
    [{ to: ['a@example.test\r\nBcc: evil@example.test'] }, /not an email address/],
    [{ cc: 'x@example.test' }, /must be a list/],
    [{ subject: 'Hi\r\nBcc: evil@example.test' }, /line break/],
    [{ subject: 7 }, /must be text/],
    [{ body: 'x'.repeat(20_001) }, /longer than/],
    [{ to: Array.from({ length: 21 }, (_, i) => `p${i}@example.test`) }, /at most 20/],
  ])('refuses %j', (change, message) => {
    expect(() => validateReplyContent({ ...base, ...change })).toThrowError(message);
    expect(() => validateReplyContent({ ...base, ...change })).toThrowError(ReplyContentError);
  });
});

describe('buildReplyMime', () => {
  it('threads the reply, carries the intent header, and round-trips through a Gmail payload', () => {
    const content = validateReplyContent({ to: ['Pat <pat@example.test>'], cc: ['c@example.test'], subject: 'Re: Lease renewal – ok', body: 'Yes.\nThanks' });
    const raw = buildReplyMime(content, {
      from: 'owner@gmail.com', messageId: '<intent-1@agentdeck.local>', intentId: 'intent-1',
      inReplyTo: CONTEXT.messageIdHeader, references: '<older@example.test> <abc@example.test>',
    });
    expect(raw).toContain('In-Reply-To: <abc@example.test>');
    expect(raw).toContain('References: <older@example.test> <abc@example.test>');
    expect(raw).toContain('X-AgentDeck-Intent: intent-1');
    expect(raw).not.toMatch(/^Bcc:/m);
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    const headers = head.split('\r\n').map((line) => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 2) }));
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\s+/g, '');
    const read = readGmailPayload({ mimeType: 'text/plain', headers, body: { data: Buffer.from(body, 'base64').toString('base64url') } });
    expect(read.content).toEqual(content);
  });
});

describe('readGmailPayload', () => {
  it('reads the plain-text part and lists attachments exactly', () => {
    const payload: GmailPayload = {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'To', value: 'pat@example.test' }, { name: 'Subject', value: '=?UTF-8?B?UmU6IENhZsOp?=' },
        { name: 'X-AgentDeck-Intent', value: 'intent-9' },
      ],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64('Hello\r\nthere') } },
          { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'lease.pdf', body: { size: 1234, attachmentId: 'a1' } },
      ],
    };
    const read = readGmailPayload(payload);
    expect(read.content).toEqual({
      to: ['pat@example.test'], cc: [], subject: 'Re: Café', body: 'Hello\nthere',
      attachments: [{ name: 'lease.pdf', mimeType: 'application/pdf', size: 1234 }],
    });
    expect(read.header('x-agentdeck-intent')).toBe('intent-9');
  });

  it('falls back to text from HTML when there is no plain part', () => {
    expect(readGmailPayload({ mimeType: 'text/html', body: { data: b64('<p>Hi&nbsp;there</p><script>x()</script><br>Bye') } }).content.body)
      .toBe('Hi there\n\nBye');
  });
});

describe('draftDigest', () => {
  it('changes with any field, including attachments', () => {
    const content = validateReplyContent({ to: ['pat@example.test'], cc: [], subject: 'Re: x', body: 'a' });
    expect(draftDigest(content)).toMatch(/^[0-9a-f]{64}$/);
    expect(draftDigest(content)).toBe(draftDigest({ ...content }));
    expect(draftDigest({ ...content, body: 'b' })).not.toBe(draftDigest(content));
    expect(draftDigest({ ...content, attachments: [{ name: 'a.pdf', mimeType: 'application/pdf', size: 1 }] })).not.toBe(draftDigest(content));
  });
});
