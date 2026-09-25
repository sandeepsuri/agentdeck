// Just enough RFC 5322 / MIME for plain-text spike messages: build one with a
// caller-chosen Message-ID and intent header, and read one back well enough to
// compare recipients, subject, and body exactly.
import type { DraftContent } from './types.js';

export const INTENT_HEADER = 'X-AgentDeck-Intent';

export function buildMime(content: DraftContent, meta: { from: string; messageId: string; intentId: string }): string {
  const headers: Array<[string, string | undefined]> = [
    ['From', meta.from],
    ['To', content.to.join(', ')],
    ['Cc', content.cc?.length ? content.cc.join(', ') : undefined],
    ['Subject', encodeHeader(content.subject)],
    ['Date', new Date().toUTCString().replace('GMT', '+0000')],
    ['Message-ID', meta.messageId],
    ['In-Reply-To', content.inReplyTo],
    ['References', content.references ?? content.inReplyTo],
    [INTENT_HEADER, meta.intentId],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
  ];
  const head = headers.filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  const body = Buffer.from(content.body, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return `${head}\r\n\r\n${body}`;
}

export interface ParsedMime {
  headers: Map<string, string>;
  body: string;
}

export function parseMime(raw: string): ParsedMime {
  const split = raw.search(/\r?\n\r?\n/);
  const headText = split < 0 ? raw : raw.slice(0, split);
  const bodyText = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  for (const line of headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), decodeHeader(line.slice(colon + 1).trim()));
  }
  const encoding = headers.get('content-transfer-encoding')?.toLowerCase();
  const body = encoding === 'base64'
    ? Buffer.from(bodyText.replace(/\s+/g, ''), 'base64').toString('utf8')
    : encoding === 'quoted-printable'
      ? decodeQuotedPrintable(bodyText)
      : bodyText;
  return { headers, body: body.replace(/\r\n/g, '\n').replace(/\n$/, '') };
}

export function contentFromMime(raw: string): DraftContent {
  const { headers, body } = parseMime(raw);
  // Split on commas outside quoted display names, e.g. "Doe, Jane" <jane@example.test>.
  const list = (value?: string) => (value ? (value.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((s) => s.trim()).filter(Boolean) : []);
  return {
    to: list(headers.get('to')),
    cc: list(headers.get('cc')),
    subject: headers.get('subject') ?? '',
    body,
    inReplyTo: headers.get('in-reply-to'),
    references: headers.get('references'),
  };
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset: string, kind: string, text: string) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : decodeQuotedPrintable(text.replace(/_/g, ' ')));
}

function decodeQuotedPrintable(text: string): string {
  const bytes = text.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}
