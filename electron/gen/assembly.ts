/*
 * The deterministic programmatic stitch (M07.C round 4; REVIEW-V11 F20). THE
 * ASSEMBLER, NOT THE MODEL, EMITS THE DOCUMENT SHELL — the structural half of the
 * security model: the shell is code-owned and script-free by construction, so no
 * model response can smuggle a shell past review. The existing DOMPurify + sandbox +
 * CSP layers (ADR-0010) are unchanged on top: the stitched document flows through the
 * SAME renderer sanitize seam as the v1 model-emitted document.
 *
 * Round 4: per-section stitching is dead (independently-generated prose never ties
 * out — ADR-0018); ONE author writes the whole body against the actual stylesheet,
 * and the stitch is shell + <style> + body. Pure and byte-deterministic: fixed inputs
 * → identical output; NO Date.now(), NO randomness (phase-doc trap).
 *
 * Structural controls in pure code (defense-in-depth, not the load-bearing layer):
 *  - fragmentViolation(): a body carrying a shell marker (or a <style> block — the
 *    html call owns NO css) is REJECTED before the stitch — a prompt bug to retry,
 *    never an input;
 *  - the css part cannot escape the shell's <style> block (every `<` CSS-escaped) and
 *    cannot pull external stylesheets (`@import` stripped — ADR-0013 posture);
 *  - code-inserted text (the document title) is HTML-escaped.
 */
export interface AssemblyInput {
  readonly title: string;
  readonly css: string;
  /** The complete document body — ONE author (M07.C round 4; per-section stitching is dead). */
  readonly body: string;
}

// Shell tags a body-level fragment must never carry. <style> is included: the shell
// owns ALL styling (the css step) — a fragment-local style block would bypass the
// single code-owned style slot.
const SHELL_TAGS = ['!doctype', 'html', 'head', 'body', 'style'] as const;

// M08.A: match each protected tag at a TAG BOUNDARY — the name followed by whitespace,
// '>', '/', or end-of-string — NOT as a substring. The substring test rejected valid
// '<header…' body markup because it contains '<head' (main.log: marker=<head). Order
// preserves the original array precedence (doctype/html/head/body before style), so a
// document carrying both a shell and a <style> reports the document-shell marker — the
// signal the service uses to route recoverable documents to the normalizer.
const SHELL_TAG_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = SHELL_TAGS.map(
  (tag) => [`<${tag}`, new RegExp(`<${tag}(?=[\\s/>]|$)`, 'i')] as const,
);

// A document-shell marker means the model returned a (partial) DOCUMENT whose body can
// be extracted (recoverable). A bare <style> marker is a fragment smuggling a style
// block — no document to extract — so it stays a rejection, never normalized (M08.A).
const DOCUMENT_SHELL_MARKERS: ReadonlySet<string> = new Set([
  '<!doctype',
  '<html',
  '<head',
  '<body',
]);

/** The first shell marker found in a fragment (at a tag boundary), or null for a clean body-level fragment. */
export function fragmentViolation(html: string): string | null {
  for (const [marker, pattern] of SHELL_TAG_PATTERNS) {
    if (pattern.test(html)) {
      return marker;
    }
  }
  return null;
}

/** True when a fragmentViolation marker denotes a document shell (recoverable), not a bare <style>. */
export function isDocumentShellMarker(marker: string): boolean {
  return DOCUMENT_SHELL_MARKERS.has(marker);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The css part is untrusted text destined for the inside of the shell's <style>
// block: strip @import (no external stylesheets — the fonts are app-provided,
// ADR-0013) and CSS-escape every `<` to `\3c ` — valid CSS that renders as '<'
// inside strings, while making EVERY markup class (a </style> escape, an embedded
// <script>, anything tag-shaped) structurally impossible inside the block. url(...)
// values are left as-is — the same exposure surface as the v1 model-emitted style.
function confineCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, '').replace(/</g, '\\3c ');
}

/**
 * Stitch the final document: code-owned shell + the (confined) theme css + the
 * validated body, verbatim. Callers MUST have rejected shell-bearing bodies via
 * fragmentViolation first (the service treats a violation as a failed attempt →
 * retry → typed failure).
 */
export function assembleDocument({ title, css, body }: AssemblyInput): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    confineCss(css),
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('\n');
}
