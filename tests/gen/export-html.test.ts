// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { InlinedImage } from '@shared/images/image-figures';

import { buildExportHtml } from '../../src/gen/export-html';

/*
 * The self-contained HTML export builder (M04.D). Export is assembled RENDERER-SIDE
 * (decision M04.D): the same DOMPurify seam that renders the doc in-app sanitizes the
 * exported file too — one sanitizer, no jsdom/main-side second runtime, and the
 * exported bytes are the same safe document plus FULL-RES screenshots inlined as raw
 * base64 (decision: raw bytes, no nativeImage decode/downscale — resolves C-14).
 *
 * The exported file opens in a plain browser (no app sandbox/CSP there), so:
 *  - it MUST carry no <script> / inline handler (sanitized — the only safety layer there);
 *  - screenshots MUST be inlined as base64 data: URIs (asset:// can't resolve in a browser);
 *  - expand-to-full MUST be PURE CSS (the :target lightbox — zero JS).
 */
const FONT_STYLE =
  '<style id="ms-fonts">@font-face{font-family:Inter;src:url(data:font/woff2;base64,AA==)}</style>';

const DOC =
  '<!doctype html><html lang="en"><head><style>.x{color:#333}</style></head><body><h1>Title</h1><p>Body</p></body></html>';

const IMAGES: InlinedImage[] = [
  { dataUri: 'data:image/png;base64,iVBORw0KGgoAAAA=', alt: 'Screenshot capture' },
];

describe('buildExportHtml', () => {
  it('keeps an assembled chunked doc’s populated theme block (M07.C IRL gap — export must carry the styling)', () => {
    const themed = [
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>WP</title>',
      '<style>\n:root { --ink: #222; }\n.callout { border-left: 4px solid var(--ink); }\n</style>',
      '</head><body><section class="gen-section"><div class="callout">Key</div></section></body></html>',
    ].join('');
    const out = buildExportHtml(themed, [], FONT_STYLE);
    expect(out).toContain('--ink: #222');
    expect(out).toContain('border-left: 4px solid var(--ink)');
    expect(out).toContain('class="callout"');
  });

  it('strips scripts / inline handlers from the untrusted doc (the only layer in a browser)', () => {
    const malicious =
      '<html><body><h1>Hi</h1><script>steal()</script><img src="x" onerror="evil()" /></body></html>';
    const out = buildExportHtml(malicious, [], FONT_STYLE);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('steal()');
    expect(out).not.toContain('onerror');
  });

  it('inlines screenshots as base64 data: URIs — no asset:// survives in the exported file', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE, { heading: 'Screenshots' });
    expect(out).toContain('data:image/png;base64,iVBORw0KGgoAAAA=');
    // Mutation check 1: leaving a screenshot as an asset:// URL must fail this.
    expect(out).not.toContain('asset://');
  });

  it('embeds a PURE-CSS lightbox (zero JS) so click-to-expand works in a plain browser', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE);
    expect(out).toContain('.ms-shot-lb:target'); // the :target overlay — pure CSS
    expect(out).not.toContain('<script'); // self-contained no-script mandate
  });

  it('injects the self-hosted fonts so the exported file is offline-self-contained', () => {
    const out = buildExportHtml(DOC, [], FONT_STYLE);
    expect(out).toContain('ms-fonts');
    expect(out).toContain('@font-face');
  });

  it('produces a well-formed standalone document even with no screenshots', () => {
    const out = buildExportHtml(DOC, [], FONT_STYLE);
    expect(out).toContain('<html');
    expect(out).toContain('Title');
    expect(out).toContain('Body');
  });
});

describe('buildExportHtml — F26 omitted-image notice (M06.C)', () => {
  it('threads omittedCount into the doc so the export is honest about a capped image set', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE, {
      heading: 'Screenshots',
      omittedCount: 7,
    });
    expect(out).toContain('ms-shots-omitted');
    expect(out).toMatch(/7 image/i);
    expect(out).toContain('data:image/png;base64,iVBORw0KGgoAAAA='); // the kept image still inlined
  });

  it('renders no notice when nothing was omitted', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE, { heading: 'Screenshots' });
    expect(out).not.toContain('ms-shots-omitted');
  });
});

/*
 * S4-010 (post-v1 audit hardening). The exported file opens in a PLAIN browser — no app
 * sandbox/CSP there — so a remote ref that a prompt injection steered the model into
 * emitting (DOMPurify passes remote img src / CSS url() / @import through; it has no
 * ALLOWED_URI_REGEXP) would beacon-on-open, defeating the self-contained/offline promise.
 * Two-layer export-only fix: (1) a blocking CSP <meta> in the exported <head>, (2) a strip
 * of remote refs on the export path (defense-in-depth for browsers that ignore meta CSP).
 * In-app render is unchanged (already protected by sandbox="" + the app CSP).
 */

// A doc carrying remote refs in ALL THREE hiding places, across variants the strip must
// cover: @import (double-quoted, bare-string), CSS url() (unquoted / single-quoted /
// protocol-relative), <img src> (absolute / protocol-relative), and inline style url().
const REMOTE_REF_DOC = [
  '<!doctype html><html lang="en"><head>',
  '<style>',
  '@import url("https://evil.example/import-dq.css");',
  "@import 'https://evil.example/import-bare.css';",
  '.a{background:url(https://evil.example/css-unquoted.png)}',
  ".b{background:url('https://evil.example/css-sq.png')}",
  '.c{background:url(//evil.example/proto-rel.png)}',
  '</style>',
  '</head><body>',
  '<h1>Quarterly Strategy</h1>',
  '<img src="https://evil.example/img-beacon.gif" alt="x" />',
  '<img src="//evil.example/img-proto.gif" alt="y" />',
  '<p style="background:url(\'https://evil.example/inline-style.png\')">visible prose</p>',
  '</body></html>',
].join('');

describe('buildExportHtml — self-contained export blocks remote refs (S4-010)', () => {
  it('injects a blocking CSP meta into the exported head (mutation check 1)', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE, { heading: 'Screenshots' });
    expect(out).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    // default-src 'none' blocks every remote load; the allowances re-permit ONLY the
    // inlined content (base64 images/fonts + inline styles) the export is built from.
    expect(out).toContain("default-src 'none'");
    expect(out).toContain('img-src data:');
    expect(out).toContain("style-src 'unsafe-inline'");
    expect(out).toContain('font-src data:');
    // meta-ignored directives must NOT appear (S6 lesson — they only warn in a <meta> CSP).
    expect(out).not.toContain('frame-ancestors');
    expect(out).not.toContain('report-uri');
  });

  it('strips remote refs in all three places — no loadable remote ref survives (mutation check 2)', () => {
    const out = buildExportHtml(REMOTE_REF_DOC, [], FONT_STYLE);
    // No variant of the planted remote host survives into the export.
    expect(out).not.toContain('evil.example');
    // No loadable absolute/protocol-relative remote URL of any kind survives.
    expect(out).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i);
    expect(out).not.toMatch(/\bsrc\s*=\s*['"]\s*(?:https?:)?\/\//i);
    expect(out).not.toMatch(/@import\s+['"]?(?:https?:)?\/\//i);
    // Over-stripping guard: legitimate content/structure is preserved.
    expect(out).toContain('Quarterly Strategy');
    expect(out).toContain('visible prose');
  });

  it('still renders self-contained under the CSP (data: images/fonts + lightbox preserved)', () => {
    const out = buildExportHtml(DOC, IMAGES, FONT_STYLE, { heading: 'Screenshots' });
    // Trusted inlined content the CSP allows — must NOT be stripped.
    expect(out).toContain('data:image/png;base64,iVBORw0KGgoAAAA='); // base64 screenshot
    expect(out).toContain('@font-face'); // base64 self-hosted font
    expect(out).toContain('.ms-shot-lb:target'); // pure-CSS lightbox intact
    expect(out).not.toContain('<script'); // self-contained no-script mandate (release-smoke gate)
  });
});
