// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SandboxedHtmlFrame } from '../../src/components/SandboxedHtmlFrame';

/*
 * The sandboxed-iframe primitive (M04.B) — the LOAD-BEARING primary control for
 * untrusted, LLM-generated HTML. It renders the supplied HTML via `srcDoc` in an
 * iframe whose `sandbox` attribute grants NO `allow-scripts` and NO
 * `allow-same-origin`, so even if a script slips past the sanitizer it cannot
 * execute and the frame gets an opaque origin with no reach into the parent / IPC /
 * node. This component does NOT sanitize — it passes HTML through verbatim — so the
 * sandbox attribute is the only thing standing between untrusted HTML and
 * execution. That separation is what lets the e2e prove the sandbox behaviorally on
 * raw, unsanitized input.
 *
 * MUTATION CHECK 2 (config half): adding `allow-scripts`/`allow-same-origin` to the
 * sandbox attribute here MUST fail the attribute assertions below. The behavioral
 * half lives in tests/e2e/generate-whitepaper.spec.ts (the sandbox probe).
 */
const RAW = '<!doctype html><html><body><h1 class="doc-title">Hi</h1></body></html>';

function frame(): HTMLIFrameElement {
  return screen.getByTitle('Sample doc') as HTMLIFrameElement;
}

describe('SandboxedHtmlFrame', () => {
  it('renders the supplied HTML into the iframe srcDoc VERBATIM (no sanitization here)', () => {
    const withScript = '<html><body><script>window.x=1</script><p>body</p></body></html>';
    render(<SandboxedHtmlFrame html={withScript} title="Sample doc" />);
    // The primitive is sanitizer-free: it passes content through so the sandbox
    // attribute is the sole control under test.
    expect(frame().getAttribute('srcdoc')).toBe(withScript);
  });

  it('applies a sandbox attribute that grants neither allow-scripts nor allow-same-origin', () => {
    render(<SandboxedHtmlFrame html={RAW} title="Sample doc" />);
    const sandbox = frame().getAttribute('sandbox');
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toMatch(/allow-scripts/);
    expect(sandbox).not.toMatch(/allow-same-origin/);
  });

  it('exposes the iframe under its accessible title', () => {
    render(<SandboxedHtmlFrame html={RAW} title="Sample doc" />);
    expect(frame().tagName).toBe('IFRAME');
  });

  // M06.E iframe-paint blocker: the post-load repaint nudge must be NON-RELOADING — it forces a
  // repaint without detaching the frame or changing its srcDoc (display:none / src reassignment
  // would reload and re-enter the un-committed-reload race that blanked the prior attempt).
  it('runs a non-reloading repaint nudge on load — srcDoc is never cleared or changed', () => {
    render(<SandboxedHtmlFrame html={RAW} title="Sample doc" />);
    const el = frame();
    expect(el.getAttribute('srcdoc')).toBe(RAW);
    // Firing load must not throw and must not blank/reload the frame.
    fireEvent.load(el);
    expect(el.getAttribute('srcdoc')).toBe(RAW); // unchanged → no reload
    expect(el.style.display).not.toBe('none'); // never detached via display:none
    // The transform toggle settles back to empty (no lingering compositor hack on screen).
    expect(['', 'translateZ(0)']).toContain(el.style.transform);
  });

  it('keeps sandbox="" across a load nudge (the §10/ADR-0010 control is untouched)', () => {
    render(<SandboxedHtmlFrame html={RAW} title="Sample doc" />);
    const el = frame();
    fireEvent.load(el);
    const sandbox = el.getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox).not.toMatch(/allow-scripts|allow-same-origin/);
  });
});
