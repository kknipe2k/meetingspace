/*
 * The shared screenshot inliner (M04.C fix batch; decision B). Minutes embed the
 * session screenshots INLINE as base64 `data:` <img> so they render inside the
 * generated-document iframe — which is `sandbox=""` (an opaque origin) where the
 * `asset://` scheme cannot resolve, exactly like the self-hosted fonts (ADR-0013).
 *
 * `buildImageFigures` is a PURE markup builder (no byte acquisition). In v1 it is
 * used MAIN-SIDE by the export path with full-resolution base64 bytes (the in-app
 * inline path was dropped in the D.x reconciliation — in-app preview is text-only,
 * images ride the export; the original renderer-side downscale inliner is deferred
 * to v2 with C-10/11). Expand-to-full is a
 * PURE-CSS `:target` lightbox — the iframe blocks scripts, so a JS lightbox can't
 * run; `:target` is plain CSS and is the same pattern the export uses. The emitted
 * markup is presentation only (no <script>, no inline handlers) and is injected
 * AFTER sanitization (it is app-trusted, not model output).
 */
export interface InlinedImage {
  /** A `data:image/...;base64,…` URI for the (downscaled, in-app / full-res export) bytes. */
  readonly dataUri: string;
  readonly alt: string;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Pure-CSS :target lightbox: a thumbnail anchors to the overlay (#ms-shot-N → the
// overlay becomes :target and displays FULL-PAGE); the overlay is the backdrop and
// anchors back to the section (#ms-shots) so a click anywhere — including the × —
// closes it. No script of any kind, so it works inside the sandboxed frame and in the
// D export verbatim.
const LIGHTBOX_STYLE = [
  '<style>',
  '.ms-shots{display:flex;flex-wrap:wrap;gap:.6rem;margin:1.75rem 0}',
  '.ms-shots-heading{flex:1 0 100%;margin:0 0 .25rem;font-family:Inter,system-ui,sans-serif;font-size:1.05rem}',
  '.ms-shot{display:block;max-width:260px;flex:0 0 auto}',
  '.ms-shot img{width:100%;height:auto;border:1px solid #e6e6ec;border-radius:6px;cursor:zoom-in}',
  '.ms-shot-lb{position:fixed;inset:0;display:none;align-items:center;justify-content:center;',
  'background:rgba(20,20,28,.88);padding:2.5rem;z-index:9;cursor:zoom-out}',
  '.ms-shot-lb:target{display:flex}',
  '.ms-shot-lb img{max-width:100%;max-height:100%;border-radius:4px}',
  '.ms-shot-close{position:fixed;top:1rem;right:1.25rem;font-family:Inter,system-ui,sans-serif;',
  'font-size:2rem;line-height:1;color:#fff;text-decoration:none}',
  '</style>',
].join('');

export interface ImageFiguresOptions {
  /** Optional section heading (e.g. "Session captures" in the white paper). */
  readonly heading?: string;
  /*
   * F26 (M06.C): how many session images were dropped because the export image cap was hit. When
   * > 0 a visible notice is rendered so a capped export is never silently lossy — even when EVERY
   * image was omitted (so the section appears with the notice but no thumbnails).
   */
  readonly omittedCount?: number;
}

export function buildImageFigures(
  images: readonly InlinedImage[],
  options: ImageFiguresOptions = {},
): string {
  const omittedCount = options.omittedCount ?? 0;
  if (images.length === 0 && omittedCount === 0) {
    return '';
  }
  const heading = options.heading
    ? `<h2 class="ms-shots-heading">${escapeAttr(options.heading)}</h2>`
    : '';
  // The omitted-count notice (F26) — presentation-only text, no active content. Pluralized.
  const omitted =
    omittedCount > 0
      ? `<p class="ms-shots-omitted">${omittedCount} image${omittedCount === 1 ? '' : 's'} omitted (export image limit reached).</p>`
      : '';
  const thumbs = images
    .map((image, i) => {
      const src = escapeAttr(image.dataUri);
      const alt = escapeAttr(image.alt);
      return `<a class="ms-shot" href="#ms-shot-${i}"><img src="${src}" alt="${alt}" /></a>`;
    })
    .join('');
  const overlays = images
    .map((image, i) => {
      const src = escapeAttr(image.dataUri);
      const alt = escapeAttr(image.alt);
      // The overlay IS the backdrop (href back to the section closes); the × is a
      // second close affordance over it.
      return (
        `<a class="ms-shot-lb" id="ms-shot-${i}" href="#ms-shots">` +
        `<span class="ms-shot-close" aria-hidden="true">×</span>` +
        `<img src="${src}" alt="${alt}" /></a>`
      );
    })
    .join('');
  return `<section class="ms-shots" id="ms-shots" aria-label="Screenshots">${LIGHTBOX_STYLE}${heading}${omitted}${thumbs}${overlays}</section>`;
}

// Insert the figures just before </body> (so they close the document) — or append
// when the HTML is a fragment with no body. No-op for empty figures.
export function injectImageFigures(html: string, figures: string): string {
  if (figures.length === 0) {
    return html;
  }
  const close = /<\/body>/i;
  if (close.test(html)) {
    return html.replace(close, (match) => `${figures}${match}`);
  }
  return html + figures;
}
