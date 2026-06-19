import { describe, expect, it } from 'vitest';

import { sandboxProbeEnabled } from '../../electron/sandbox-probe-gate';

/*
 * The sandbox-probe gate (M04.B). The e2e-only sandbox probe (raw, unsanitized
 * malicious HTML rendered through SandboxedHtmlFrame under a permissive-CSP probe
 * page) must be STRUCTURALLY UNREACHABLE in a shipped build — exactly like the
 * fake-LLM seam. This pins the gate predicate so production-unreachability is
 * enforced by a test, not merely asserted in a comment: a packaged build never
 * enables the probe, regardless of the env flag.
 */
describe('sandboxProbeEnabled', () => {
  it('is enabled only when the flag is set AND the build is unpackaged', () => {
    expect(sandboxProbeEnabled('1', false)).toBe(true);
  });

  it('is NEVER enabled in a packaged (production) build, even with the flag set', () => {
    expect(sandboxProbeEnabled('1', true)).toBe(false);
  });

  it('is disabled when the flag is absent or not exactly "1"', () => {
    expect(sandboxProbeEnabled(undefined, false)).toBe(false);
    expect(sandboxProbeEnabled('0', false)).toBe(false);
    expect(sandboxProbeEnabled('true', false)).toBe(false);
  });
});
