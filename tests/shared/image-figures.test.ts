import { describe, expect, it } from 'vitest';

import {
  buildImageFigures,
  injectImageFigures,
  type InlinedImage,
} from '../../shared/images/image-figures';

/*
 * The shared screenshot inliner (M04.C fix batch; decision B). Minutes embed the
 * session screenshots INLINE as base64 data: <img> (not an adjacent React gallery) so
 * they render inside the sandbox="" generated-document iframe — an opaque origin where
 * asset:// can't resolve, exactly like the self-hosted fonts. `buildImageFigures` is a
 * PURE builder (markup only, no byte acquisition), so Stage-D's export reuses it
 * main-side with full-res bytes. Expand-to-full is a PURE-CSS :target lightbox (no
 * script — the frame blocks scripts), the same pattern the export uses.
 */
const IMAGES: InlinedImage[] = [
  { dataUri: 'data:image/jpeg;base64,QQ==', alt: 'Screenshot capture' },
  { dataUri: 'data:image/jpeg;base64,Ulo=', alt: 'Screenshot paste' },
];

describe('buildImageFigures', () => {
  const html = buildImageFigures(IMAGES);

  it('emits one inline data: <img> per screenshot, with its alt', () => {
    expect(html).toContain('data:image/jpeg;base64,QQ==');
    expect(html).toContain('data:image/jpeg;base64,Ulo=');
    expect(html).toContain('alt="Screenshot capture"');
    expect(html.match(/<img/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps the screenshots in a labelled section', () => {
    expect(html).toMatch(/<section[^>]*class="ms-shots"/);
  });

  it('provides a PURE-CSS :target lightbox (no JavaScript) for expand-to-full', () => {
    // A :target rule in a <style> + an id'd overlay + an anchor to it = script-free
    // expand, which is the only kind that works inside the sandboxed frame.
    expect(html).toMatch(/<style/);
    expect(html).toContain(':target');
    expect(html).toContain('id="ms-shot-0"');
    expect(html).toContain('href="#ms-shot-0"');
  });

  it('expands FULL-PAGE (position:fixed; inset:0) with a backdrop + × close', () => {
    expect(html).toContain('position:fixed');
    expect(html).toContain('inset:0');
    // Clicking the overlay backdrop returns to the section anchor (closes); plus a
    // visible × affordance. Same markup is reused by the D export.
    expect(html).toContain('href="#ms-shots"');
    expect(html).toContain('ms-shot-close');
  });

  it('renders an optional section heading when provided (white-paper "Session captures")', () => {
    expect(buildImageFigures(IMAGES, { heading: 'Session captures' })).toContain(
      '<h2 class="ms-shots-heading">Session captures</h2>',
    );
    // No heading element when none is requested (the CSS rule is still in <style>).
    expect(buildImageFigures(IMAGES)).not.toContain('<h2');
  });

  it('carries no active content (no <script>, no inline handlers)', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('returns an empty string when there are no screenshots', () => {
    expect(buildImageFigures([])).toBe('');
  });
});

describe('buildImageFigures — F26 omitted-count notice (M06.C)', () => {
  it('renders a visible "N images omitted" notice when omittedCount > 0', () => {
    const html = buildImageFigures(IMAGES, { omittedCount: 4 });
    expect(html).toContain('ms-shots-omitted');
    expect(html).toMatch(/4 image/i);
    expect(html).toMatch(/omitted/i);
  });

  it('omits the notice entirely when nothing was dropped (omittedCount 0)', () => {
    expect(buildImageFigures(IMAGES, { omittedCount: 0 })).not.toContain('ms-shots-omitted');
    expect(buildImageFigures(IMAGES)).not.toContain('ms-shots-omitted');
  });

  it('still surfaces the notice when ALL images were omitted (never silent — empty image list)', () => {
    const html = buildImageFigures([], { omittedCount: 3, heading: 'Screenshots' });
    expect(html).toContain('ms-shots-omitted');
    expect(html).toMatch(/3 image/i);
  });

  it('the notice carries no active content', () => {
    const html = buildImageFigures(IMAGES, { omittedCount: 2 });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
  });
});

describe('injectImageFigures', () => {
  it('inserts the figures just before </body>', () => {
    const out = injectImageFigures(
      '<html><body><h1>Minutes</h1></body></html>',
      '<section>F</section>',
    );
    expect(out).toContain('<h1>Minutes</h1><section>F</section></body>');
  });

  it('appends the figures when the document has no </body>', () => {
    const out = injectImageFigures('<h1>frag</h1>', '<section>F</section>');
    expect(out).toBe('<h1>frag</h1><section>F</section>');
  });

  it('is a no-op for empty figures', () => {
    expect(injectImageFigures('<body>x</body>', '')).toBe('<body>x</body>');
  });
});
