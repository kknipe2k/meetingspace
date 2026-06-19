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

// Shell markers a body-level fragment must never carry. <style> is included: the
// shell owns ALL styling (the css step) — a fragment-local style block would bypass
// the single code-owned style slot.
const SHELL_MARKERS = ['<!doctype', '<html', '<head', '<body', '<style'] as const;

/** The first shell marker found in a fragment, or null for a clean body-level fragment. */
export function fragmentViolation(html: string): string | null {
  const lower = html.toLowerCase();
  for (const marker of SHELL_MARKERS) {
    if (lower.includes(marker)) {
      return marker;
    }
  }
  return null;
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
