// Issue #81: the text a confined agent may see from one granted PDF.
// AgentDeck extracts it itself, from bytes it already fingerprinted, so the
// agent never opens a file. Extraction is bounded (inflate budget, output
// length) and purely lexical: text-showing operators inside BT…ET blocks and
// the document title. Nothing in the text is interpreted; the broker hands
// it to the agent labelled as untrusted document data.
import zlib from 'node:zlib';

export interface PdfTextLimits {
  /** Characters of text returned per document. */
  maxChars?: number;
  /** Total bytes all inflated streams may expand to, against compression bombs. */
  maxInflatedBytes?: number;
  /** Content streams examined per document. */
  maxStreams?: number;
}

export interface PdfText {
  title?: string;
  text: string;
  truncated: boolean;
}

export const DEFAULT_MAX_TEXT_CHARS = 6000;
const DEFAULT_MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STREAMS = 400;

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** Reads one literal string starting at `open` (the opening parenthesis). Returns the decoded bytes and the index after it. */
function readLiteral(source: string, open: number): { value: string; end: number } {
  let depth = 1;
  let value = '';
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next in ESCAPES) {
        value += ESCAPES[next];
        i += 2;
      } else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4))![0];
        value += String.fromCharCode(parseInt(octal, 8) & 0xff);
        i += 1 + octal.length;
      } else {
        // A backslash before a line break continues the string; anything else drops the backslash.
        i += next === '\r' && source[i + 2] === '\n' ? 3 : 2;
        if (next !== '\n' && next !== '\r') value += next;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth > 0) value += ch;
    i += 1;
  }
  return { value, end: i };
}

function decodeHex(hex: string): string | undefined {
  const digits = hex.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(digits)) return undefined;
  const bytes = Buffer.from(digits.length % 2 ? `${digits}0` : digits, 'hex');
  // Two-byte CID strings need the font's CMap to mean anything; only plain
  // single-byte text is kept.
  return bytes.every((byte) => byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f))
    ? bytes.toString('latin1')
    : undefined;
}

/** PDF text strings are PDFDocEncoding (≈ Latin-1) unless they start with a UTF-16BE byte-order mark. */
function decodeTextString(raw: string): string {
  if (raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    return Buffer.from(raw.slice(2), 'latin1').swap16().toString('utf16le');
  }
  return raw;
}

/** Text shown inside BT…ET blocks of one content stream. */
export function textFromContent(content: string): string {
  const parts: string[] = [];
  let inText = false;
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === '%') {
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      const literal = readLiteral(content, i);
      if (inText) parts.push(literal.value);
      i = literal.end;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i);
      if (close < 0) break;
      const decoded = inText ? decodeHex(content.slice(i + 1, close)) : undefined;
      if (decoded !== undefined) parts.push(decoded);
      i = close + 1;
      continue;
    }
    const token = /^[A-Za-z*'"]+/.exec(content.slice(i, i + 16))?.[0];
    if (token) {
      if (token === 'BT') inText = true;
      else if (token === 'ET') { inText = false; parts.push('\n'); }
      else if (inText && (token === 'Td' || token === 'TD' || token === 'T*' || token === "'" || token === '"')) parts.push('\n');
      else if (inText && token === 'TJ') parts.push(' ');
      i += token.length;
      continue;
    }
    i += 1;
  }
  return parts.join('');
}

/** The dictionary just before a `stream` keyword, looked up within a fixed window so a hostile file cannot make it quadratic. */
function streamDictionary(source: string, streamKeyword: number): string {
  const window = source.slice(Math.max(0, streamKeyword - 2048), streamKeyword);
  const start = window.lastIndexOf('obj');
  return start < 0 ? window.slice(-512) : window.slice(start);
}

function clean(text: string): string {
  return text
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

export function extractPdfText(bytes: Buffer, limits: PdfTextLimits = {}): PdfText {
  const maxChars = limits.maxChars ?? DEFAULT_MAX_TEXT_CHARS;
  let inflateBudget = limits.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
  const maxStreams = limits.maxStreams ?? DEFAULT_MAX_STREAMS;
  const source = bytes.toString('latin1');

  const titleMatch = /\/Title\s*\(/.exec(source);
  const titleStart = titleMatch ? titleMatch.index + titleMatch[0].length - 1 : -1;
  const title = titleMatch ? clean(decodeTextString(readLiteral(source.slice(titleStart, titleStart + 4096), 0).value)) : '';

  const chunks: string[] = [];
  let collected = 0;
  let streams = 0;
  let cursor = 0;
  while (collected <= maxChars && streams < maxStreams && inflateBudget > 0) {
    const keyword = source.indexOf('stream', cursor);
    if (keyword < 0) break;
    // Skip the "endstream" keyword itself.
    if (source.slice(keyword - 3, keyword) === 'end') { cursor = keyword + 6; continue; }
    let dataStart = keyword + 6;
    if (source[dataStart] === '\r') dataStart += 1;
    if (source[dataStart] === '\n') dataStart += 1;
    const dataEnd = source.indexOf('endstream', dataStart);
    if (dataEnd < 0) break;
    cursor = dataEnd + 9;
    streams += 1;

    const dictionary = streamDictionary(source, keyword);
    // Images, fonts, and metadata are not page text.
    if (/\/Subtype\s*\/(Image|Form|XML)|\/Length[123]\b|\/Type\s*\/(XObject|Metadata|XRef|ObjStm)/.test(dictionary)) continue;
    const filters = [...dictionary.matchAll(/\/(\w+Decode)\b/g)].map((match) => match[1]);
    if (filters.some((filter) => filter !== 'FlateDecode')) continue;

    let content: Buffer = bytes.subarray(dataStart, dataEnd);
    if (filters.length > 0) {
      try {
        content = zlib.inflateSync(content, { maxOutputLength: inflateBudget, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        continue;
      }
    }
    inflateBudget -= content.length;
    const text = textFromContent(content.toString('latin1'));
    if (text.trim()) {
      chunks.push(text);
      collected += text.length;
    }
  }

  const text = clean(chunks.join('\n'));
  return {
    ...(title ? { title: title.slice(0, 200) } : {}),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
