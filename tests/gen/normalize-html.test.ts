// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assembleDocument, fragmentViolation } from '../../electron/gen/assembly';
import { normalizeBodyFragment, normalizeMinutesDocument } from '../../electron/gen/normalize-html';

/*
 * M08.A — the parse5-backed body-fragment normalizer (ADR-0026). The recovery seam
 * for the white-paper HTML step: when the model returns a COMPLETE document instead
 * of the body-level fragment the pipeline expects, extract ONLY the body's children,
 * discard the model doctype/<html>/<head>/<style>, and hand a clean fragment to the
 * EXISTING assembly + renderer sanitizer. It EXTRACTS — it never sanitizes and never
 * emits a shell (the renderer DOMPurify + sandbox + CSP stay load-bearing, ADR-0010).
 *
 * Completeness is judged INDEPENDENTLY of a successful parse (parse5 repairs): an
 * empty normalized body is rejected, not inferred-complete.
 *
 * MUTATION CHECKS (run at verify_gates):
 *   - return the whole doc instead of body children → the "head/style discarded" pins fail;
 *   - drop the empty-body reject → the empty-document test fails.
 */

const FULL_DOC = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8" /><title>Model title</title>',
  '<style>.model-css{color:red}</style>',
  '</head>',
  '<body>',
  '<header class="document-header">Q3 Review</header>',
  '<h2>Introduction</h2><p>First.</p>',
  '<table><tr><td>x</td></tr></table>',
  '</body>',
  '</html>',
].join('');

describe('normalizeBodyFragment — recover a full document into a clean body fragment', () => {
  it('extracts ONLY the body children — the model doctype/<html>/<head> are gone', () => {
    const result = normalizeBodyFragment(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lower = result.fragment.toLowerCase();
    expect(lower).not.toContain('<!doctype');
    expect(lower).not.toContain('<html');
    expect(lower).not.toContain('<title');
    // No <head> SHELL element — checked at a tag boundary so the preserved <header> body
    // markup (which merely begins with "head") does NOT count as a shell tag.
    expect(lower).not.toContain('<head>');
    expect(lower).not.toContain('<head ');
    expect(fragmentViolation(result.fragment)).toBeNull();
  });

  it('discards the model <style> (the app owns the single stylesheet — never adopt model CSS)', () => {
    const result = normalizeBodyFragment(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fragment).not.toContain('<style');
    expect(result.fragment).not.toContain('.model-css');
  });

  it('preserves body-level semantic markup, including <header> (the false-positive that started this)', () => {
    const result = normalizeBodyFragment(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fragment).toContain('<header class="document-header">');
    expect(result.fragment).toContain('<h2>Introduction</h2>');
    expect(result.fragment).toContain('<table>');
    expect(result.fragment).toContain('First.');
  });

  it('discards a body-LEVEL <style> too (a stray style block inside body is model CSS, dropped)', () => {
    const withBodyStyle =
      '<html><body><h2>X</h2><style>.b{color:blue}</style><p>Y</p></body></html>';
    const result = normalizeBodyFragment(withBodyStyle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fragment).not.toContain('<style');
    expect(result.fragment).not.toContain('.b{color:blue}');
    expect(result.fragment).toContain('<h2>X</h2>');
    expect(result.fragment).toContain('<p>Y</p>');
  });

  it('the recovered fragment is itself shell-free — fragmentViolation accepts it', () => {
    const result = normalizeBodyFragment(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fragmentViolation(result.fragment)).toBeNull();
  });

  it('the recovered fragment assembles into a doc with EXACTLY one app-owned shell + one style', () => {
    const result = normalizeBodyFragment(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = assembleDocument({
      title: 'White paper',
      css: ':root{--ink:#222}',
      body: result.fragment,
    });
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc.match(/<style/gi)).toHaveLength(1);
    expect(doc.match(/<\/style>/gi)).toHaveLength(1);
    // The app's css is present; the model's is not.
    expect(doc).toContain('--ink:#222');
    expect(doc).not.toContain('.model-css');
  });
});

describe('normalizeBodyFragment — never silently accept bad output (completeness ≠ a successful parse)', () => {
  it('rejects an empty document body with reason "empty" (parse5 repairs — we judge completeness ourselves)', () => {
    const emptyBody = '<html><head><style>.a{}</style></head><body></body></html>';
    const result = normalizeBodyFragment(emptyBody);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('rejects a body of only whitespace/discardable shell as "empty" (no meaningful content)', () => {
    const onlyStyle = '<html><body>   <style>.a{}</style>  </body></html>';
    const result = normalizeBodyFragment(onlyStyle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('rejects a document with no <body> (e.g. a frameset) as "unparseable"', () => {
    // A frameset document parses to html > head + frameset — there is NO body element to
    // extract a fragment from, so the seam refuses rather than emit anything.
    const frameset = '<html><frameset><frame src="x" /></frameset></html>';
    const result = normalizeBodyFragment(frameset);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unparseable');
  });

  it('rejects as "ambiguous" when an extracted fragment still carries a shell marker', () => {
    // A <style> nested inside a <template> survives the body-level style strip (template
    // content is a separate document fragment) and reappears on serialize — the extracted
    // fragment is therefore not shell-free, so the seam refuses rather than emit it.
    const templated = '<html><body><template><style>.x{}</style></template></body></html>';
    const result = normalizeBodyFragment(templated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
  });
});

/*
 * M08.B — the parse5-backed MINUTES normalizer (ADR-0026). Distinct from the white-paper
 * body-fragment mode: minutes are a SINGLE self-contained <html> document, so the seam
 * keeps ONE document shell (parse5 hoists duplicate/misplaced shells into one tree) and
 * at most ONE head stylesheet — it does NOT route through fragmentViolation (a full
 * <html> minutes doc is valid, not a shell violation). It strips categorically-prohibited
 * constructs structurally (all scripts/handlers/iframes/forms/links/@import — the
 * contract bans them outright, so no per-URL safety judgment is made; that stays with the
 * renderer DOMPurify + sandbox + CSP, ADR-0010). It EXTRACTS/NORMALIZES — it is not the
 * security boundary. Completeness is judged independently of a successful parse: an empty
 * body is rejected; a doc whose prohibited construct SURVIVED the structural strip (e.g.
 * smuggled inside <template> content) is refused as ambiguous rather than persisted.
 *
 * MUTATION CHECKS (run at verify_gates):
 *   - drop the empty-body reject → the empty-body test passes-through (fails the suite);
 *   - keep every head <style> instead of only the first → the one-stylesheet test fails.
 */
const FENCE = '```';

const VALID_MINUTES = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
  '<style>:root{--accent:#5e6ad2;}table{border-collapse:collapse;}</style>',
  '</head><body>',
  '<header>Weekly Standup</header>',
  '<main><section><h1>Meeting Minutes</h1>',
  '<table><tr><td>Owner</td><td>Action</td></tr></table>',
  '</section></main>',
  '<footer>End of minutes</footer>',
  '</body></html>',
].join('');

describe('normalizeMinutesDocument — keep ONE self-contained document shell', () => {
  it('accepts a clean complete minutes document with exactly one shell + one stylesheet', () => {
    const result = normalizeMinutesDocument(VALID_MINUTES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.document;
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc.match(/<head>/gi)).toHaveLength(1); // the <head> shell, NOT the preserved <header>
    expect(doc.match(/<header>/gi)).toHaveLength(1); // <header> survives as semantic markup
    expect(doc.match(/<body/gi)).toHaveLength(1);
    expect(doc.match(/<style/gi)).toHaveLength(1);
  });

  it('preserves semantic minutes markup (<header>/<main>/<section>/<table>/<footer>)', () => {
    const result = normalizeMinutesDocument(VALID_MINUTES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toContain('<header>Weekly Standup</header>');
    expect(result.document).toContain('<main>');
    expect(result.document).toContain('<section>');
    expect(result.document).toContain('<table>');
    expect(result.document).toContain('<footer>End of minutes</footer>');
    expect(result.document).toContain('Meeting Minutes');
  });

  it('unwraps an enclosing markdown ```html fence around the whole document', () => {
    const fenced = `${FENCE}html\n${VALID_MINUTES}\n${FENCE}`;
    const result = normalizeMinutesDocument(fenced);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).not.toContain(FENCE);
    expect(result.document).toContain('Meeting Minutes');
  });

  it('normalizes duplicate/misplaced shell elements to a single shell', () => {
    const dupes =
      '<html><head></head><body><h1>First</h1></body></html>' +
      '<html><body><h2>Second</h2></body></html>';
    const result = normalizeMinutesDocument(dupes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.match(/<html/gi)).toHaveLength(1);
    expect(result.document.match(/<body/gi)).toHaveLength(1);
    expect(result.document).toContain('First');
    expect(result.document).toContain('Second');
  });

  it('retains at most one stylesheet — duplicate/body <style> cannot produce multiple', () => {
    const manyStyles =
      '<html><head><style>.a{color:red}</style><style>.b{color:blue}</style></head>' +
      '<body><h1>X</h1><style>.c{color:green}</style></body></html>';
    const result = normalizeMinutesDocument(manyStyles);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.match(/<style/gi)).toHaveLength(1);
    expect(result.document).toContain('.a{color:red}'); // the first head stylesheet kept
    expect(result.document).not.toContain('.b{color:blue}');
    expect(result.document).not.toContain('.c{color:green}');
  });

  it('strips scripts, inline handlers, iframes, forms, links, and @import (prohibited constructs)', () => {
    const hostile = [
      '<html><head>',
      '<script>evil()</script>',
      '<link rel="stylesheet" href="https://x/remote.css" />',
      '<style>@import url(https://x/remote2.css);.k{color:red}</style>',
      '</head><body>',
      '<h1 onclick="evil()">Title</h1>',
      '<iframe src="https://x"></iframe>',
      '<form action="https://x"><input /></form>',
      '<p>Body text.</p>',
      '</body></html>',
    ].join('');
    const result = normalizeMinutesDocument(hostile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.document;
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<iframe/i);
    expect(doc).not.toMatch(/<form/i);
    expect(doc).not.toMatch(/<link/i);
    expect(doc).not.toMatch(/onclick/i);
    expect(doc).not.toMatch(/@import/i);
    // The legitimate content survives.
    expect(doc).toContain('Title');
    expect(doc).toContain('Body text.');
    expect(doc).toContain('.k{color:red}');
  });
});

describe('normalizeMinutesDocument — never persist bad output (completeness ≠ a successful parse)', () => {
  it('rejects an empty document body with reason "empty"', () => {
    const emptyBody = '<html><head><style>.a{}</style></head><body></body></html>';
    const result = normalizeMinutesDocument(emptyBody);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('rejects a body of only whitespace + discarded prohibited constructs as "empty"', () => {
    const onlyScript = '<html><body>   <script>x()</script>  </body></html>';
    const result = normalizeMinutesDocument(onlyScript);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('rejects a document with no <body> (e.g. a frameset) as "unparseable"', () => {
    const frameset = '<html><frameset><frame src="x" /></frameset></html>';
    const result = normalizeMinutesDocument(frameset);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unparseable');
  });

  it('rejects as "ambiguous" when a prohibited construct survived the structural strip', () => {
    // A <script> nested inside <template> content is a separate document fragment that the
    // childNode strip does not walk, so it reappears on serialize. The post-normalization
    // re-scan catches it: the seam REFUSES rather than persist a script-bearing document
    // (the renderer sanitizer would also strip it, but main-side we never emit it).
    const templated =
      '<html><body><h1>Real content</h1><template><script>evil()</script></template></body></html>';
    const result = normalizeMinutesDocument(templated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
  });
});
