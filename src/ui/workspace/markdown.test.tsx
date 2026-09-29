// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseMarkdown } from './markdown.js';

describe('parseMarkdown', () => {
  it('splits fenced code, headings, lists and paragraphs', () => {
    expect(parseMarkdown('## Plan\nFirst line\nsecond line\n\n- one\n- two\n  continued\n1. a\n2. b\n```ts\nconst x = 1;\n```')).toEqual([
      { kind: 'heading', level: 2, text: 'Plan' },
      { kind: 'paragraph', text: 'First line\nsecond line' },
      { kind: 'list', ordered: false, items: ['one', 'two continued'] },
      { kind: 'list', ordered: true, items: ['a', 'b'] },
      { kind: 'code', lang: 'ts', text: 'const x = 1;' },
    ]);
  });

  it('keeps an unterminated fence as code', () => {
    expect(parseMarkdown('```\nstill streaming')).toEqual([{ kind: 'code', lang: '', text: 'still streaming' }]);
  });

  it('parses a GFM table, keeping an empty header cell and padding short rows', () => {
    const source = [
      'What the commits show is already built:',
      '',
      '| Issue | Commit on feat/simplify-product | |',
      '|---|---|---|',
      '| #81 Propose a PDF filing plan | f358146 |',
      '| #84 Install and launch the Mac app | 91ead05, c46b627 | extra | dropped |',
      '',
      'Done.',
    ].join('\n');
    expect(parseMarkdown(source)).toEqual([
      { kind: 'paragraph', text: 'What the commits show is already built:' },
      {
        kind: 'table',
        align: [null, null, null],
        header: ['Issue', 'Commit on feat/simplify-product', ''],
        rows: [
          ['#81 Propose a PDF filing plan', 'f358146', ''],
          ['#84 Install and launch the Mac app', '91ead05, c46b627', 'extra'],
        ],
      },
      { kind: 'paragraph', text: 'Done.' },
    ]);
  });

  it('reads column alignment, pipes inside code and escaped pipes', () => {
    expect(parseMarkdown('a | b | c\n:-- | :-: | --:\n`x | y` | a \\| b | 3')).toEqual([
      { kind: 'table', align: ['left', 'center', 'right'], header: ['a', 'b', 'c'], rows: [['`x | y`', 'a | b', '3']] },
    ]);
  });

  it('leaves a line with a stray pipe as a paragraph', () => {
    expect(parseMarkdown('use a | b here\nnext line')).toEqual([{ kind: 'paragraph', text: 'use a | b here\nnext line' }]);
  });
});

describe('Markdown', () => {
  it('renders inline code, bold, italics and http links', () => {
    const html = renderToStaticMarkup(<Markdown text={'Run `npm test`, **then** *ship* — see [docs](https://example.com/a).'} />);
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('<strong>then</strong>');
    expect(html).toContain('<em>ship</em>');
    expect(html).toContain('<a href="https://example.com/a" rel="noreferrer noopener" target="_blank">docs</a>');
  });

  it('renders a table with inline formatting and alignment', () => {
    const html = renderToStaticMarkup(<Markdown text={'| Issue | Commit |\n|---|--:|\n| **#81** | `f358146` |'} />);
    expect(html).toContain('<div class="md-table-wrap"><table><thead><tr><th>Issue</th><th style="text-align:right">Commit</th></tr></thead>');
    expect(html).toContain('<td><strong>#81</strong></td><td style="text-align:right"><code>f358146</code></td>');
  });

  it('never turns agent text into markup or script links', () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)> [x](javascript:alert(1))'} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;img');
  });
});
