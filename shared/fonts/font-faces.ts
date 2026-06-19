/*
 * The shared font inliner (M04.C font self-hosting; ADR-0013). The generated-document
 * render iframe is `sandbox=""` — an opaque origin — so neither `font-src 'self'` nor
 * the `asset://` scheme resolves inside it. The designed fonts (Inter + Merriweather,
 * SIL OFL-1.1, vendored under assets/fonts/) therefore ride as base64 `data:` URIs in
 * an injected `@font-face` block, which the app CSP permits via `font-src 'self' data:`.
 *
 * `buildFontFaceStyle` is a PURE builder over already-inlined faces, so BOTH contexts
 * reuse it: the renderer (Stage C render wrapper) supplies data URIs via Vite `?inline`,
 * and main (Stage D export) will supply them via readFileSync+base64 — same bytes, same
 * builder, one source of truth. The emitted <style> is presentation only (no scripts /
 * handlers), and is injected AFTER sanitization (it is app-trusted, not model output).
 */
export interface FontFace {
  readonly family: string;
  readonly weight: number;
  readonly style?: 'normal' | 'italic';
}

export interface InlinedFontFace extends FontFace {
  /** A `data:font/woff2;base64,…` URI for the (vendored, subsetted) font bytes. */
  readonly dataUri: string;
}

// The faces the generation prompts use: Merriweather body (400/700), Inter headers /
// callouts / illustrations (400/600/700). Metadata only — the bytes are attached per
// context (see src/gen/fonts.ts for the renderer).
export const GENERATED_DOC_FONT_FACES: readonly FontFace[] = [
  { family: 'Merriweather', weight: 400 },
  { family: 'Merriweather', weight: 700 },
  { family: 'Inter', weight: 400 },
  { family: 'Inter', weight: 600 },
  { family: 'Inter', weight: 700 },
];

// Emit a self-contained <style> with one @font-face per inlined face. font-display:swap
// paints text immediately and swaps the font in when it loads (no invisible-text flash).
export function buildFontFaceStyle(faces: readonly InlinedFontFace[]): string {
  const rules = faces
    .map(
      (face) =>
        `@font-face{font-family:'${face.family}';font-style:${face.style ?? 'normal'};` +
        `font-weight:${face.weight};font-display:swap;` +
        `src:url(${face.dataUri}) format('woff2')}`,
    )
    .join('');
  return `<style data-fonts="generated-doc">${rules}</style>`;
}

// Insert the font <style> inside the document's <head> (so it applies before the body
// renders); if the HTML has no <head> (a fragment), prepend it. The style is trusted
// app content injected AFTER the untrusted HTML is sanitized.
export function injectFontFaces(html: string, style: string): string {
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (match) => `${match}${style}`);
  }
  return style + html;
}
