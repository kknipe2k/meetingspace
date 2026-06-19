// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { assembleDocument, fragmentViolation } from '../../electron/gen/assembly';
import { sanitizeHtml } from '../../src/gen/sanitize-html';

/*
 * M07.C round 4 — the programmatic stitch. THE ASSEMBLER, NOT THE MODEL, EMITS THE
 * DOCUMENT SHELL (the structural security control: the shell is code-owned and
 * script-free by construction; ADR-0010's sanitize/sandbox/CSP layers are unchanged
 * on top). One author writes the whole body (per-section stitching is dead), so the
 * stitch is now shell + <style> + body. Pure: fixed inputs → byte-identical output;
 * no Date.now(), no randomness (phase-doc trap).
 *
 * MUTATION CHECKS (run at verify_gates):
 *   - perturb the stitch (e.g. drop/duplicate the body) → the determinism pins fail;
 *   - neuter sanitizeHtml → the hostile-body assertions fail.
 */
const CSS = ':root { --ink: #222; } p { line-height: 1.6; }';

const BODY =
  '<h2>Introduction</h2><p>First.</p><h2>Architecture</h2><p>Second.</p><h2>Conclusion</h2><p>Third.</p>';

const DOC_INPUT = { title: 'Q3 Review', css: CSS, body: BODY };

describe('assembleDocument — deterministic, code-owned shell', () => {
  it('is byte-deterministic: the same inputs assemble to the identical string, twice', () => {
    const first = assembleDocument(DOC_INPUT);
    const second = assembleDocument(DOC_INPUT);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
    // Different inputs are a different document.
    expect(assembleDocument({ ...DOC_INPUT, body: '<p>Other.</p>' })).not.toBe(first);
  });

  it('emits the code-owned shell: doctype, html/head/body, ONE style block carrying the css, the body verbatim', () => {
    const doc = assembleDocument(DOC_INPUT);
    expect(doc.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<html');
    expect(doc).toContain('</html>');
    // Exactly one <style> open and one close — the shell's own, holding the theme css.
    expect(doc.match(/<style/gi)).toHaveLength(1);
    expect(doc.match(/<\/style>/gi)).toHaveLength(1);
    expect(doc).toContain('--ink: #222');
    // The body lands once, in order, untouched.
    expect(doc.indexOf('First.')).toBeGreaterThan(-1);
    expect(doc.indexOf('Second.')).toBeGreaterThan(doc.indexOf('First.'));
    expect(doc.indexOf('Third.')).toBeGreaterThan(doc.indexOf('Second.'));
    expect(doc.match(/First\./g)).toHaveLength(1);
  });

  it('HTML-escapes the code-inserted document title', () => {
    const doc = assembleDocument({ ...DOC_INPUT, title: 'A & B <Launch>' });
    expect(doc).toContain('A &amp; B &lt;Launch&gt;');
    expect(doc).not.toContain('<Launch>');
  });

  it('neutralizes a </style> escape inside the css part (no breaking out of the shell style block)', () => {
    const hostileCss = 'p { color: red; } </style><script>alert(1)</script><style>';
    const doc = assembleDocument({ ...DOC_INPUT, css: hostileCss });
    // Still exactly one real close tag — the shell's own.
    expect(doc.match(/<\/style>/gi)).toHaveLength(1);
    expect(doc).not.toContain('<script>alert(1)</script>');
  });

  it('strips @import from the css part (no external stylesheets — ADR-0013 posture)', () => {
    const doc = assembleDocument({
      ...DOC_INPUT,
      css: '@import url("https://evil.example/x.css");\np { margin: 0; }',
    });
    expect(doc).not.toContain('@import');
    expect(doc).toContain('margin: 0');
  });
});

describe('fragmentViolation — a model-emitted shell (or style block) is a prompt bug, never a stitch input', () => {
  it('flags shell markers in a body (doctype/html/head/body/style — the html call owns NO css)', () => {
    expect(fragmentViolation('<!doctype html><p>x</p>')).not.toBeNull();
    expect(fragmentViolation('<html><p>x</p></html>')).not.toBeNull();
    expect(fragmentViolation('<head><title>t</title></head>')).not.toBeNull();
    expect(fragmentViolation('<body><p>x</p></body>')).not.toBeNull();
    expect(fragmentViolation('<style>p{}</style><p>x</p>')).not.toBeNull();
    // Case-insensitive — a shouting shell is still a shell.
    expect(fragmentViolation('<HTML><P>x</P></HTML>')).not.toBeNull();
  });

  it('accepts a clean body-level document (headings, lists, divs, tables, classes)', () => {
    expect(
      fragmentViolation(
        '<h2>Title</h2><div class="callout"><ul><li>a</li></ul></div><table><tr><td>x</td></tr></table>',
      ),
    ).toBeNull();
  });
});

describe('stitch + sanitize seam — the theme MUST survive (pins what must remain, not only what must not)', () => {
  it('a styled doc keeps its populated <style> block AND its rules through the REAL sanitize seam', () => {
    const themed = assembleDocument({
      title: 'Styled',
      css: ':root { --ink: #222; }\n.callout { border-left: 4px solid var(--ink); padding: 1rem; }',
      body: '<h2>Core</h2><div class="callout">Key point</div>',
    });

    const safe = sanitizeHtml(themed);
    // The style block survives INTACT — a sanitizer-config tightening that strips
    // <style> (or rewrites its content) must fail here, not at the next IRL.
    expect(safe.match(/<style/gi)).toHaveLength(1);
    expect(safe).toContain('--ink: #222');
    expect(safe).toContain('border-left: 4px solid var(--ink)');
    // …and the class the rule targets is still on the element it styles.
    expect(safe).toContain('class="callout"');
  });
});

describe('stitch + sanitize seam — a hostile body never survives to active content', () => {
  it('a body carrying script/handler/javascript: vectors is inert after the existing sanitize seam', () => {
    const hostile = assembleDocument({
      title: 'Hostile',
      css: CSS,
      body: [
        '<h2>Injected</h2>',
        '<script>document.title="pwned"</script>',
        '<img src="x" onerror="alert(1)" />',
        '<a href="javascript:alert(2)">click</a>',
      ].join(''),
    });

    // The stitched doc flows through the SAME renderer sanitize seam as the v1
    // model-emitted doc (placement decision: whole-document, at the existing layer).
    const safe = sanitizeHtml(hostile);
    expect(safe).not.toContain('<script');
    expect(safe).not.toContain('onerror');
    expect(safe).not.toContain('javascript:');
    // The legitimate content and the shell's style block survive (no over-stripping).
    expect(safe).toContain('Injected');
    expect(safe).toContain('--ink: #222');
  });
});
