// Builds small but valid PDFs (issue #81 tests and demo): one page of
// Helvetica text per document, with a real cross-reference table, so the
// same bytes open in Preview and exercise the text extractor.
import zlib from 'node:zlib';

export interface TextPdfOptions {
  title?: string;
  /** FlateDecode the page content, as most real PDFs do. Default true. */
  compress?: boolean;
}

function literal(text: string): string {
  return `(${text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

export function buildTextPdf(lines: readonly string[], options: TextPdfOptions = {}): Buffer {
  const content = Buffer.from(
    `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line, index) => `${index === 0 ? '' : 'T* '}${literal(line)} Tj`).join(' ')} ET`,
    'latin1',
  );
  const compress = options.compress ?? true;
  const stream = compress ? zlib.deflateSync(content) : content;
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.from(`<< /Producer (AgentDeck test fixture)${options.title ? ` /Title ${literal(options.title)}` : ''} >>`),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(length);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>`,
    'startxref',
    String(length),
    '%%EOF',
    '',
  ].join('\n');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
