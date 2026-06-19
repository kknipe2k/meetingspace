import { injectFontFaces } from '@shared/fonts/font-faces';
import {
  buildImageFigures,
  injectImageFigures,
  type InlinedImage,
} from '@shared/images/image-figures';

import { sanitizeHtml } from './sanitize-html';

/*
 * The self-contained HTML export builder (M04.D, ADR-0009). Export is assembled
 * RENDERER-SIDE so the SAME DOMPurify seam that renders the doc in-app also sanitizes
 * the exported file — one sanitizer, no main-side jsdom second runtime, no divergence.
 * The exported bytes are the safe document plus FULL-RES screenshots inlined as base64
 * (decision M04.D: raw bytes from collectRawImages — no nativeImage decode/downscale,
 * resolving C-14) and the self-hosted @font-face fonts, so the file opens offline in a
 * plain browser with click-to-expand intact.
 *
 * Layering mirrors GeneratedDocView's in-app render: sanitize FIRST (the only safety
 * layer in a browser — no app sandbox/CSP there), THEN inject the app-trusted figures
 * and fonts. The figures carry a PURE-CSS :target lightbox (zero JS), satisfying both
 * the self-contained no-script mandate and the click-to-expand UX.
 *
 * S4-010 (post-v1 audit): the export opens in a PLAIN browser, so DOMPurify's pass-through
 * of remote references (it has no ALLOWED_URI_REGEXP — remote <img src>, CSS url(), and
 * @import survive) would let a prompt-injected remote ref in untrusted meeting content
 * beacon-on-open, defeating the self-contained/offline promise. Two EXPORT-ONLY layers
 * close it (in-app render is unchanged — already protected by sandbox="" + the app CSP):
 *   1. EXPORT_CSP — a blocking CSP <meta> injected into the exported <head>;
 *   2. stripRemoteRefs — a strip of remote src/url()/@import on the export path
 *      (defense-in-depth for any browser that ignores a <meta> CSP).
 * The shared sanitizer (sanitize-html.ts) is intentionally left byte-stable.
 */
export interface ExportHtmlOptions {
  /** Section heading for the inlined screenshots (e.g. "Screenshots"). */
  readonly heading?: string;
  /*
   * F26 (M06.C): images dropped by the export cap. Threaded into the figures so the exported
   * file carries an honest "N images omitted" notice — a capped export is never silently lossy.
   */
  readonly omittedCount?: number;
}

/*
 * The self-contained export CSP. default-src 'none' blocks every remote load by default;
 * the three allowances re-permit EXACTLY the content the export inlines — base64 images,
 * inline <style>/style= (doc styles + lightbox + @font-face block), and base64 fonts — so
 * the document renders identically while no remote request can fire. Only directives that
 * are honored in a <meta> CSP on file:// are used; frame-ancestors/report-uri are OMITTED
 * (meta-ignored → console warnings — the S6 lesson).
 */
const EXPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;

// Insert the CSP <meta> as the FIRST child of <head> (parsed before any resource); if the
// document has no <head>, prepend it so it still leads the file.
function injectExportCsp(html: string): string {
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (match) => `${match}${EXPORT_CSP_META}`);
  }
  return EXPORT_CSP_META + html;
}

// A remote ref = an absolute http(s): URL or a protocol-relative //host one. data:/about:
// and in-document #fragments are left intact (that's the inlined content the CSP allows).
const REMOTE_URL = String.raw`(?:https?:)?\/\/`;

/*
 * Strip remote references from the export, EXPORT-ONLY (the in-app render relies on the
 * app CSP + sandbox, not this strip). Runs on the already-DOMPurify-sanitized untrusted
 * doc — well-formed, no script/handlers — so a focused transform is safe and the meta CSP
 * remains the primary control. Trusted base64 figures/fonts are injected AFTERWARD and
 * carry only data: URIs, so they are never touched. Covers the audit's three hiding places:
 *   - CSS url(...) in <style> and inline style= (incl. @import url(...))  → url(about:blank)
 *   - @import with a bare-string remote URL                              → removed
 *   - <img src>/srcset remote attributes                                 → attribute removed
 */
export function stripRemoteRefs(html: string): string {
  return (
    html
      // CSS url(...) — quoted or unquoted, in <style> blocks and inline style attributes.
      .replace(
        new RegExp(String.raw`url\(\s*(['"]?)\s*${REMOTE_URL}[^)'"]*\1\s*\)`, 'gi'),
        'url(about:blank)',
      )
      // @import with a bare string URL (the url() form is already neutralized above).
      .replace(new RegExp(String.raw`@import\s+(['"])${REMOTE_URL}[^'"]*\1\s*;?`, 'gi'), '')
      // A now-empty/about:blank @import keyword left dangling — drop it (no-op import).
      .replace(/@import\s+url\(about:blank\)\s*;?/gi, '')
      // Remote src / srcset attributes (double- or single-quoted).
      .replace(
        new RegExp(String.raw`\s(?:src|srcset)\s*=\s*(["'])\s*${REMOTE_URL}[^"']*\1`, 'gi'),
        '',
      )
  );
}

export function buildExportHtml(
  doc: string,
  images: readonly InlinedImage[],
  fontStyle: string,
  options: ExportHtmlOptions = {},
): string {
  const safe = stripRemoteRefs(sanitizeHtml(doc));
  const omittedCount = options.omittedCount ?? 0;
  const withImages =
    images.length > 0 || omittedCount > 0
      ? injectImageFigures(
          safe,
          buildImageFigures(images, {
            ...(options.heading ? { heading: options.heading } : {}),
            ...(omittedCount > 0 ? { omittedCount } : {}),
          }),
        )
      : safe;
  // CSP last so the <meta> lands as the first <head> child, ahead of the injected fonts.
  return injectExportCsp(injectFontFaces(withImages, fontStyle));
}
