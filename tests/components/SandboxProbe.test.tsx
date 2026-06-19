// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SandboxProbe } from '../../src/components/SandboxProbe';

/*
 * The e2e-only sandbox probe (M04.B). It renders RAW, UNSANITIZED malicious HTML
 * through the SandboxedHtmlFrame so the e2e can prove the sandbox blocks scripts on
 * its own. This unit pins that it passes the raw script-bearing fixture through
 * verbatim (no sanitization) and applies the no-allow-scripts sandbox — i.e. the
 * sandbox is the only thing standing between this fixture and execution.
 */
describe('SandboxProbe', () => {
  it('renders the raw malicious fixture through a script-free sandbox', () => {
    render(<SandboxProbe />);
    const frame = screen.getByTitle('Sandbox probe') as HTMLIFrameElement;
    const srcdoc = frame.getAttribute('srcdoc') ?? '';

    // Raw, unsanitized: the script + onerror vectors are present in the document
    // the frame receives — the sandbox (not a sanitizer) must neutralize them.
    expect(srcdoc).toMatch(/<script/i);
    expect(srcdoc).toContain('onerror');
    expect(srcdoc).toContain('SANDBOX_XSS_EXECUTED');

    const sandbox = frame.getAttribute('sandbox');
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toMatch(/allow-scripts/);
    expect(sandbox).not.toMatch(/allow-same-origin/);
  });
});
