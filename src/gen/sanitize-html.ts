import DOMPurify, { type Config } from 'dompurify';

/*
 * The sanitizer seam (M04.B) — the DEFENSE-IN-DEPTH layer for untrusted,
 * LLM-generated HTML. The white paper is assembled from untrusted meeting content,
 * so a prompt injection in a pasted transcript can steer the model into emitting a
 * <script>, an inline on*= handler, or a javascript:/data:text/html URL. This pure
 * function strips all of those (plus embedding elements that could load active
 * content) WHILE preserving the prompt's legitimate presentation — the single
 * <style> block with its CSS illustrations, CSS classes, and the Google-Fonts
 * <link>. Over-stripping would break the illustrations the white paper is built on.
 *
 * This is the SECONDARY control. The PRIMARY, load-bearing control is the
 * SandboxedHtmlFrame (an isolated iframe with no allow-scripts / allow-same-origin):
 * even if a vector slipped past this sanitizer, it could not execute. We never trust
 * the prompt's "no scripts" mandate (the model is steered by untrusted content) and
 * we never trust the sanitizer alone. ADR-0010.
 *
 * DOMPurify (3.4.8, exact-pinned) backs this seam — a battle-tested, DOM-based
 * sanitizer rather than a bypass-prone hand-rolled regex pass. It runs against the
 * renderer's real DOM. WHOLE_DOCUMENT keeps the full <html>/<head>/<style> shape of
 * a self-contained document; script/iframe/object/embed/base/form are forbidden;
 * inline event handlers and javascript:/data: URLs are stripped by DOMPurify's
 * defaults.
 *
 * M04.C tightening (ADR-0013): external <link> tags are NO LONGER re-allowed — fonts
 * are now self-hosted as base64 @font-face (injected after sanitization), so there is
 * no legitimate external stylesheet to permit. Dropping the <link> allowance kills
 * the blocked-request console warning AND removes an external-<link> exfil vector. The
 * sandbox + script/handler/URL stripping (the B controls) are unchanged.
 */
const SANITIZE_CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  // Active-content / embedding elements: never. (script is forbidden by default;
  // listing it is belt-and-suspenders.) <link> is intentionally NOT in ADD_TAGS —
  // DOMPurify's default strips it, so external stylesheets/preconnects are removed.
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
  // Return a plain string (not a TrustedHTML / DOM node) for the iframe srcDoc.
  RETURN_TRUSTED_TYPE: false,
};

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
