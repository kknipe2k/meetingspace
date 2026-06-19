// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from '../../src/gen/sanitize-html';

/*
 * The sanitizer seam (M04.B) — the DEFENSE-IN-DEPTH layer of the two-layer control
 * for untrusted, LLM-generated HTML (the sandboxed iframe is the load-bearing
 * primary control; see tests/components/SandboxedHtmlFrame.test.tsx + the e2e). A
 * white paper is assembled from untrusted meeting content, so a prompt injection in
 * a pasted transcript can steer the model into emitting a <script>, an inline
 * on*= handler, or a javascript:/data:text/html URL. This pure function strips all
 * of those while PRESERVING the prompt's legitimate presentation (the single
 * <style> block, CSS classes, the Google-Fonts <link>, and the CSS illustrations) —
 * over-stripping breaks the illustrations (gotcha / phase-doc trap).
 *
 * MUTATION CHECK 1: if sanitizeHtml returns its input unchanged, the
 * "<script>/onerror survive" assertions below MUST fail.
 */

// A full self-contained white paper (the Part-2 output shape) carrying BOTH the
// legitimate presentation the prompt mandates AND every injection vector untrusted
// content could carry.
const MALICIOUS_DOC = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8" />',
  '<link rel="preconnect" href="https://fonts.googleapis.com" />',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&family=Merriweather" />',
  '<style>',
  '  :root { --accent: #5e6ad2; }',
  '  .illustration-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }',
  '  .callout { border-left: 4px solid var(--accent); padding: 0.5rem; }',
  '</style>',
  '<script>window.__SANITIZE_BYPASS__ = true;</script>',
  '</head>',
  '<body>',
  '<h1>Quarterly Strategy</h1>',
  '<section class="illustration-grid">',
  '<div class="callout">Illustration 1: Core Elements</div>',
  '</section>',
  '<img src="x" onerror="window.__SANITIZE_BYPASS__ = true" alt="diagram" />',
  '<a href="javascript:window.__SANITIZE_BYPASS__=true">click</a>',
  '<a href="data:text/html,<script>1</script>">data</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<object data="https://evil.example/x.swf"></object>',
  '<embed src="https://evil.example/x.swf" />',
  '<p>We shipped MeetingSpace v1 on Friday.</p>',
  '</body>',
  '</html>',
].join('\n');

describe('sanitizeHtml', () => {
  const clean = sanitizeHtml(MALICIOUS_DOC);

  it('strips <script> elements', () => {
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain('window.__SANITIZE_BYPASS__');
  });

  it('strips inline event handlers (onerror, onload, …)', () => {
    expect(clean).not.toMatch(/onerror\s*=/i);
    expect(clean).not.toMatch(/\son\w+\s*=/i);
  });

  it('strips dangerous URL schemes (javascript:, data:text/html)', () => {
    expect(clean.toLowerCase()).not.toContain('javascript:');
    expect(clean.toLowerCase()).not.toContain('data:text/html');
  });

  it('strips embedding elements (<iframe>, <object>, <embed>)', () => {
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<object/i);
    expect(clean).not.toMatch(/<embed/i);
  });

  it('preserves the legitimate <style> block and CSS class rules', () => {
    expect(clean).toMatch(/<style/i);
    expect(clean).toContain('.illustration-grid');
    expect(clean).toContain('--accent');
  });

  it('strips external stylesheet / preconnect <link> tags (M04.C: fonts are self-hosted)', () => {
    // The font self-hosting work drops the external-<link> permission — a tightening:
    // it kills the blocked-request console warning AND removes an external-<link>
    // exfil vector. The designed fonts now ride base64 @font-face (ADR-0013).
    expect(clean).not.toContain('fonts.googleapis.com');
    expect(clean).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it('preserves the CSS illustration markup and body prose', () => {
    expect(clean).toContain('illustration-grid');
    expect(clean).toContain('Illustration 1: Core Elements');
    expect(clean).toContain('We shipped MeetingSpace v1 on Friday.');
  });

  it('is idempotent (sanitizing already-clean HTML is a no-op)', () => {
    expect(sanitizeHtml(clean)).toBe(clean);
  });

  it('returns a string for empty / trivial input without throwing', () => {
    expect(typeof sanitizeHtml('')).toBe('string');
    expect(sanitizeHtml('<p>hi</p>')).toContain('hi');
  });
});
