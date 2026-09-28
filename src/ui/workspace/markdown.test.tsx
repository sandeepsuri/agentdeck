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
});

describe('Markdown', () => {
  it('renders inline code, bold, italics and http links', () => {
    const html = renderToStaticMarkup(<Markdown text={'Run `npm test`, **then** *ship* — see [docs](https://example.com/a).'} />);
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('<strong>then</strong>');
    expect(html).toContain('<em>ship</em>');
    expect(html).toContain('<a href="https://example.com/a" rel="noreferrer noopener" target="_blank">docs</a>');
  });

  it('never turns agent text into markup or script links', () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)> [x](javascript:alert(1))'} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;img');
  });
});
