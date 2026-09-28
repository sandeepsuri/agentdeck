// Issue #88: the exact content of a reply draft. Recipients and subject are
// derived by AgentDeck from the message being answered — never from the
// agent or from anything the email's body says — and every owner edit is
// validated here before it reaches Gmail. Plain text only; a draft read back
// from Gmail reports any attachment the owner added there, so what is shown
// is exactly what Gmail holds.
import { createHash } from 'node:crypto';
import type { EmailMessageContext, ReplyAttachment, ReplyDraftContent } from './types.js';

export const INTENT_HEADER = 'X-AgentDeck-Intent';
export const MAX_RECIPIENTS = 20;
export const MAX_SUBJECT = 300;
export const MAX_BODY = 20_000;

export class ReplyContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyContentError';
  }
}

/** Splits a header address list on commas outside quoted display names. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((entry) => entry.trim()).filter(Boolean);
}

// A display name (optionally quoted) and <addr>, or a bare addr. No line breaks,
// commas outside quotes, or other header syntax can get through.
const BARE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const NAMED = /^(?:"[^"\r\n\\]*"|[^"<>,;:\r\n\\@]*)\s*<([^<>\s]+)>$/;

function validateAddress(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ReplyContentError(`Each ${field} recipient must be text.`);
  const trimmed = value.trim();
  const named = NAMED.exec(trimmed);
  const bare = named ? named[1]! : trimmed;
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || !BARE.test(bare) || trimmed.length > 320) {
    throw new ReplyContentError(`"${trimmed.slice(0, 80)}" is not an email address.`);
  }
  return trimmed;
}

function validateList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ReplyContentError(`${field} must be a list of addresses.`);
  if (value.length > MAX_RECIPIENTS) throw new ReplyContentError(`A reply can have at most ${MAX_RECIPIENTS} ${field} recipients.`);
  return value.map((entry) => validateAddress(entry, field));
}

/** Validates an owner edit. Attachments are never added from AgentDeck. */
export function validateReplyContent(input: { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown }): ReplyDraftContent {
  const to = validateList(input.to, 'To');
  if (to.length === 0) throw new ReplyContentError('A reply needs at least one recipient.');
  const cc = validateList(input.cc ?? [], 'Cc');
  if (typeof input.subject !== 'string') throw new ReplyContentError('The subject must be text.');
  if (/[\r\n]/.test(input.subject)) throw new ReplyContentError('The subject cannot contain a line break.');
  if (/[\u0000-\u001f\u007f]/.test(input.subject)) throw new ReplyContentError('The subject cannot contain control characters.');
  const subject = input.subject.trim();
  if (subject.length > MAX_SUBJECT) throw new ReplyContentError(`The subject is longer than ${MAX_SUBJECT} characters.`);
  if (typeof input.body !== 'string') throw new ReplyContentError('The message must be text.');
  const body = input.body.replace(/\r\n?/g, '\n');
  if (body.length > MAX_BODY) throw new ReplyContentError(`The message is longer than ${MAX_BODY} characters.`);
  if (body.includes('\u0000')) throw new ReplyContentError('The message cannot contain a NUL character.');
  return { to, cc, subject, body, attachments: [] };
}

/** Reply (not reply-all) to the message's Reply-To, or its sender. */
export function replyFor(context: EmailMessageContext): { to: string[]; cc: string[]; subject: string } {
  const to = parseAddressList(context.replyTo ?? context.from);
  const subject = /^re:/i.test(context.subject.trim()) ? context.subject.trim() : `Re: ${context.subject.trim()}`;
  return { to, cc: [], subject };
}

/** The References header a reply to this message carries. */
export function referencesFor(context: EmailMessageContext): string | undefined {
  const value = [context.references, context.messageIdHeader].filter(Boolean).join(' ').trim();
  return value || undefined;
}

export interface ReplyHeaders {
  readonly from: string;
  readonly messageId: string;
  readonly intentId: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** One plain-text RFC 5322 message. Header values come only from validated content. */
export function buildReplyMime(content: ReplyDraftContent, headers: ReplyHeaders): string {
  const lines: Array<[string, string | undefined]> = [
    ['From', headers.from],
    ['To', content.to.map(encodeHeader).join(', ')],
    ['Cc', content.cc.length ? content.cc.map(encodeHeader).join(', ') : undefined],
    ['Subject', encodeHeader(content.subject)],
    ['Message-ID', headers.messageId],
    ['In-Reply-To', headers.inReplyTo],
    ['References', headers.references],
    [INTENT_HEADER, headers.intentId],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
  ];
  const head = lines.filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  const body = Buffer.from(content.body.replace(/\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return `${head}\r\n\r\n${body}`;
}

// --- reading what Gmail holds -------------------------------------------------

export interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset: string, kind: string, text: string) => (
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8')
  ));
}

const decodeBody = (data: string | undefined) => Buffer.from(data ?? '', 'base64url').toString('utf8');

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ReadPayload {
  readonly content: ReplyDraftContent;
  /** A header by case-insensitive name, decoded. */
  header(name: string): string | undefined;
}

/** Reads a Gmail `format=full` payload: headers, the plain-text body, and every attachment. */
export function readGmailPayload(payload: GmailPayload): ReadPayload {
  const headers = new Map((payload.headers ?? []).map((entry) => [entry.name.toLowerCase(), decodeHeader(entry.value)]));
  let plain: string | undefined;
  let html: string | undefined;
  const attachments: ReplyAttachment[] = [];
  const walk = (part: GmailPayload) => {
    if (part.filename) {
      attachments.push({ name: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body?.size ?? 0 });
      return;
    }
    if (part.mimeType === 'text/plain' && plain === undefined && part.body?.data !== undefined) plain = decodeBody(part.body.data);
    else if (part.mimeType === 'text/html' && html === undefined && part.body?.data !== undefined) html = decodeBody(part.body.data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const body = (plain ?? (html !== undefined ? htmlToText(html) : '')).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return {
    content: {
      to: parseAddressList(headers.get('to')),
      cc: parseAddressList(headers.get('cc')),
      subject: headers.get('subject') ?? '',
      body,
      attachments,
    },
    header: (name) => headers.get(name.toLowerCase()),
  };
}

/** SHA-256 over exactly what the draft holds; an approval to send (issue #89) binds to it. */
export function draftDigest(content: ReplyDraftContent): string {
  return createHash('sha256').update(JSON.stringify({
    to: content.to, cc: content.cc, subject: content.subject, body: content.body,
    attachments: content.attachments.map((entry) => ({ name: entry.name, mimeType: entry.mimeType, size: entry.size })),
  })).digest('hex');
}
