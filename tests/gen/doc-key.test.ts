import { describe, expect, it } from 'vitest';

import { docIdentityKey } from '../../src/gen/doc-key';

/*
 * The SandboxedHtmlFrame React `key` source (M06.E iframe-paint blocker). It must remount the
 * frame ONLY on a real content change (so the frame never thrashes on unrelated re-renders),
 * which means: identical content → identical key; different content → different key.
 */
describe('docIdentityKey', () => {
  it('is STABLE for identical content (no remount thrash on re-render)', () => {
    const html = '<h1>Strategy</h1><p>Body text that the author wrote.</p>';
    expect(docIdentityKey(html)).toBe(docIdentityKey(html));
  });

  it('CHANGES when the content changes (a regenerate / a different artifact remounts)', () => {
    expect(docIdentityKey('<h1>A</h1>')).not.toBe(docIdentityKey('<h1>B</h1>'));
  });

  it('distinguishes same-length-but-different content', () => {
    expect(docIdentityKey('<p>abc</p>')).not.toBe(docIdentityKey('<p>xyz</p>'));
  });

  it('encodes the length so a hash collision still differs by size', () => {
    expect(docIdentityKey('').startsWith('0:')).toBe(true);
    expect(docIdentityKey('abc').startsWith('3:')).toBe(true);
  });
});
