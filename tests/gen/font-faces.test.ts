import { describe, expect, it } from 'vitest';

import {
  buildFontFaceStyle,
  GENERATED_DOC_FONT_FACES,
  injectFontFaces,
  type InlinedFontFace,
} from '../../shared/fonts/font-faces';

/*
 * The shared font inliner (M04.C font self-hosting). The generated-document render
 * iframe is sandbox="" (opaque origin), so `font-src 'self'` and `asset://` cannot
 * resolve inside it — the designed fonts (Inter + Merriweather, SIL OFL-1.1, vendored)
 * must ride as base64 `data:` URIs in an injected @font-face block. `buildFontFaceStyle`
 * is a PURE builder (it takes already-inlined faces and emits a self-contained <style>),
 * so Stage-D's export can reuse it MAIN-SIDE with the same vendored bytes. This is the
 * shared seam; only the byte-acquisition (Vite `?inline` in the renderer vs readFileSync
 * in main) differs per context. ADR-0013.
 */
const SAMPLE: InlinedFontFace[] = [
  { family: 'Merriweather', weight: 400, dataUri: 'data:font/woff2;base64,TUVSUkkw' },
  { family: 'Inter', weight: 700, dataUri: 'data:font/woff2;base64,SU5URVI3' },
];

describe('buildFontFaceStyle', () => {
  const style = buildFontFaceStyle(SAMPLE);

  it('emits one @font-face per face with family / weight / woff2 data src', () => {
    expect(style).toMatch(/^<style/);
    expect(style.match(/@font-face/g)?.length).toBe(2);
    expect(style).toContain("font-family:'Merriweather'");
    expect(style).toContain('font-weight:400');
    expect(style).toContain("font-family:'Inter'");
    expect(style).toContain('font-weight:700');
    expect(style).toContain("src:url(data:font/woff2;base64,TUVSUkkw) format('woff2')");
  });

  it('uses font-display:swap so text paints before the font loads', () => {
    expect(style).toContain('font-display:swap');
  });

  it('carries no active content (it is presentation only)', () => {
    expect(style).not.toMatch(/<script/i);
    expect(style).not.toMatch(/\son\w+\s*=/i);
  });
});

describe('GENERATED_DOC_FONT_FACES', () => {
  it('declares Merriweather 400/700 + Inter 400/600/700 (the weights the prompts use)', () => {
    const set = GENERATED_DOC_FONT_FACES.map((f) => `${f.family}-${f.weight}`).sort();
    expect(set).toEqual(
      ['Inter-400', 'Inter-600', 'Inter-700', 'Merriweather-400', 'Merriweather-700'].sort(),
    );
  });
});

describe('injectFontFaces', () => {
  it('inserts the font <style> inside <head> of a self-contained document', () => {
    const out = injectFontFaces(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>',
      '<style data-fonts="generated-doc">S</style>',
    );
    expect(out).toMatch(/<head[^>]*><style data-fonts="generated-doc">S<\/style>/);
    expect(out).toContain('<body>x</body>');
  });

  it('prepends the style when the document has no <head>', () => {
    const out = injectFontFaces('<div>frag</div>', '<style>S</style>');
    expect(out.startsWith('<style>S</style>')).toBe(true);
    expect(out).toContain('<div>frag</div>');
  });
});
