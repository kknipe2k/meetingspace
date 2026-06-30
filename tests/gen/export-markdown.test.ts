import { describe, expect, it } from 'vitest';

import { buildMarkdown } from '../../src/gen/export-markdown';

/*
 * The secondary plain-text export (M04.D). Markdown is the lightweight, screenshot-free
 * companion to the self-contained HTML export — it strips the generated document to its
 * readable text so it pastes anywhere. (Screenshots live in the HTML export; ADR-0009.)
 */
describe('buildMarkdown', () => {
  it('reduces a generated HTML doc to readable plain text (no tags survive)', () => {
    const doc =
      '<!doctype html><html><head><style>.x{color:red}</style></head><body><h1>Quarterly review</h1><p>We shipped M04.</p></body></html>';
    const md = buildMarkdown(doc);
    expect(md).toContain('Quarterly review');
    expect(md).toContain('We shipped M04.');
    expect(md).not.toContain('<');
    expect(md).not.toContain('color:red'); // style block content dropped
  });

  it('does not carry a <script> through to the text export', () => {
    const md = buildMarkdown('<body><p>safe</p><script>evil()</script></body>');
    expect(md).toContain('safe');
    expect(md).not.toContain('evil()');
    expect(md).not.toContain('script');
  });

  // CodeQL "Bad HTML filtering regexp" (export-markdown.ts:26): a regex that requires a
  // closing </script> lets an UNCLOSED <script> leak its body into the text. A real parser
  // puts the trailing text inside the script element, so it is dropped with the subtree.
  it('drops an unclosed <script> and its body (no closing tag)', () => {
    const md = buildMarkdown('<body><p>safe</p><script>evil()');
    expect(md).toContain('safe');
    expect(md).not.toContain('evil()');
    expect(md).not.toContain('script');
  });

  // CodeQL "Incomplete multi-character sanitization" (export-markdown.ts:22): a single
  // non-recursive pass over <head>/<style> can be slipped by duplicate/nested shells. A
  // parser hoists them into one tree, so no stylesheet text survives regardless.
  it('drops content from duplicate/nested head + style blocks', () => {
    const md = buildMarkdown(
      '<head><style>.a{color:red}</style></head><head><style>.b{color:blue}</style></head><body><p>body text</p></body>',
    );
    expect(md).toContain('body text');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('color:blue');
    expect(md).not.toContain('<');
  });

  it('maps h1/h2/h3 to markdown heading levels', () => {
    const md = buildMarkdown('<h1>One</h1><h2>Two</h2><h3>Three</h3>');
    expect(md).toContain('# One');
    expect(md).toContain('## Two');
    expect(md).toContain('### Three');
  });

  it('decodes common HTML entities and normalizes &nbsp; to a space', () => {
    const md = buildMarkdown('<p>A&nbsp;&amp;&nbsp;B &lt;tag&gt; &quot;q&quot;</p>');
    expect(md).toContain('A & B <tag> "q"');
  });
});
