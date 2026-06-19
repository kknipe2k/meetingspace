import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * CSP-layer regression guard (M04.B). The generated-document render path is
 * protected by THREE layers: (1) DOMPurify sanitization, (2) the sandboxed iframe
 * (no allow-scripts / allow-same-origin), and (3) the production app's
 * Content-Security-Policy, which a `srcdoc` frame INHERITS — so `script-src 'self'`
 * independently blocks inline scripts in the white-paper frame (verified empirically
 * in M04.B). This test locks layer 3 in place: the SHIPPED page must keep a strict
 * script-src with NO 'unsafe-inline', so a future edit can't silently remove the
 * third layer. (The test-only probe page intentionally relaxes this; it is gated
 * unreachable in production — see sandbox-probe-gate.test.ts.)
 */
const PROD_INDEX = resolve(__dirname, '../../src/index.html');

function cspOf(html: string): string {
  const match = html.match(/Content-Security-Policy"\s*content="([^"]*)"/s);
  return match?.[1] ?? '';
}

describe('production CSP (the third render-safety layer)', () => {
  const csp = cspOf(readFileSync(PROD_INDEX, 'utf8'));

  it('declares a Content-Security-Policy', () => {
    expect(csp.length).toBeGreaterThan(0);
  });

  it("restricts script-src to 'self' with NO 'unsafe-inline'", () => {
    const scriptSrc = csp.match(/script-src([^;]*)/)?.[1] ?? '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it("allows self-hosted base64 fonts via font-src 'self' data:, keeping the rest strict", () => {
    // M04.C: the render iframe is sandbox="" (opaque origin), so the designed fonts
    // ride base64 data: URIs in an injected @font-face — font-src must allow data:.
    // This is the ONLY relaxation; default-src/script-src stay strict and no external
    // font origin (googleapis/gstatic) is permitted (ADR-0013).
    const fontSrc = csp.match(/font-src([^;]*)/)?.[1] ?? '';
    expect(fontSrc).toContain("'self'");
    expect(fontSrc).toContain('data:');
    const defaultSrc = csp.match(/default-src([^;]*)/)?.[1] ?? '';
    expect(defaultSrc).toContain("'self'");
    expect(csp).not.toContain('googleapis');
    expect(csp).not.toContain('gstatic');
  });

  it('hardens object-src / base-uri (audit S6-002)', () => {
    // Defense-in-depth: no plugins/embeds, no <base> hijack. (frame-ancestors is
    // deliberately omitted — it is ignored in a <meta> CSP, where it only emits a
    // console warning; it's an HTTP-header directive and moot for a file:// app.)
    expect(csp).toMatch(/object-src\s+'none'/);
    expect(csp).toMatch(/base-uri\s+'self'/);
    expect(csp).not.toContain('frame-ancestors');
  });
});
