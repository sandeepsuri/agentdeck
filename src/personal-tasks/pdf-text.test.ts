import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildTextPdf } from '../test-fixtures/pdf.js';
import { extractPdfText, textFromContent } from './pdf-text.js';

describe('extractPdfText', () => {
  it('reads text from a compressed content stream and the document title', () => {
    const pdf = buildTextPdf(['City Power & Light', 'Statement date: March 3, 2026', 'Amount due (USD): 84.12'], { title: 'March statement' });
    expect(extractPdfText(pdf)).toEqual({
      title: 'March statement',
      text: 'City Power & Light\nStatement date: March 3, 2026\nAmount due (USD): 84.12',
      truncated: false,
    });
  });

  it('reads uncompressed streams and decodes escapes', () => {
    const pdf = buildTextPdf(['a (b) c\\d'], { compress: false });
    expect(extractPdfText(pdf).text).toBe('a (b) c\\d');
  });

  it('only returns text shown inside BT…ET blocks, with printable hex strings', () => {
    expect(textFromContent('(outside) Tj BT (in) Tj <48656c6c6f> Tj [(A) -20 (B)] TJ ET (after) Tj')).toBe('inHelloAB \n');
    // Two-byte CID strings are meaningless without the font's CMap.
    expect(textFromContent('BT <00410042> Tj ET')).toBe('\n');
  });

  it('decodes a UTF-16 title', () => {
    const utf16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Résumé', 'utf16le').swap16()]).toString('latin1');
    const pdf = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Title (${utf16}) >>\nendobj\n%%EOF`, 'latin1');
    expect(extractPdfText(pdf).title).toBe('Résumé');
  });

  it('bounds the returned text and marks it truncated', () => {
    const pdf = buildTextPdf(Array.from({ length: 50 }, (_, index) => `Line ${index} ${'x'.repeat(40)}`));
    const result = extractPdfText(pdf, { maxChars: 100 });
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('stops inflating at the budget, so a compression bomb costs nothing', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20));
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      bomb,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);
    const started = Date.now();
    expect(extractPdfText(pdf, { maxInflatedBytes: 1024 * 1024 }).text).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('strips control and bidi characters that could disguise text', () => {
    // Page text here is Latin-1, so the bidi override travels in a UTF-16 title.
    const title = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('pay\u202efdp.exe', 'utf16le').swap16()]).toString('latin1');
    const pdf = Buffer.concat([
      buildTextPdf(['bell\u0007', 'tab\there'], { compress: false }),
      Buffer.from(`\n7 0 obj\n<< /Title (${title}) >>\nendobj\n`, 'latin1'),
    ]);
    expect(extractPdfText(pdf)).toMatchObject({ title: 'pay fdp.exe', text: 'bell\ntab here' });
  });

  it('stays linear on hostile structure', () => {
    const hostile = Buffer.from(`%PDF-1.7\n${'stream\nendstream\n'.repeat(300)}${'%'.repeat(200_000)}`, 'latin1');
    const content = zlib.deflateSync(Buffer.from(`BT ${'%\n'.repeat(1_000_000)}(end) Tj ET`, 'latin1'));
    const pdf = Buffer.concat([hostile, Buffer.from(`\n9 0 obj << /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream', 'latin1')]);
    const started = Date.now();
    expect(extractPdfText(pdf).text).toBe('end');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
