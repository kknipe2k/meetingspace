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
});
