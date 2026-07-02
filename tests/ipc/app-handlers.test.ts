import { describe, expect, it } from 'vitest';

import { APP_CHANNELS } from '../../electron/ipc/channels';
import { registerAppExternalHandlers } from '../../electron/ipc/app-handlers';
import { ANTHROPIC_PRICING_URL } from '@shared/links';

/*
 * M10.B ext#2 (§10) — the app:open-pricing-docs handler. The deny-all window-open policy
 * (electron/window-guards.ts) forbids window.open / target=_blank, so the pricing-docs link opens
 * through this argument-less main-side channel: the handler calls shell.openExternal on a HARDCODED
 * shared constant and IGNORES anything the (untrusted) renderer sends — there is no open-arbitrary-URL
 * surface. Pure seam over an { openExternal } dep so the policy is Node-unit-testable.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;
function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (c, h) => handlers.set(c, h), handlers };
}

describe('registerAppExternalHandlers — app:open-pricing-docs', () => {
  it('points at the current pricing page, not the 404 /docs/en/pricing (ext#3)', () => {
    // Web-verified 2026-07-01: about-claude/pricing serves the model-pricing table; /docs/en/pricing 404s.
    expect(ANTHROPIC_PRICING_URL).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
  });

  it('opens exactly the ANTHROPIC_PRICING_URL constant', () => {
    const opened: string[] = [];
    const reg = fakeRegistrar();
    registerAppExternalHandlers(reg, { openExternal: (url) => opened.push(url) });

    reg.handlers.get(APP_CHANNELS.openPricingDocs)?.({});
    expect(opened).toEqual([ANTHROPIC_PRICING_URL]);
  });

  it('IGNORES any renderer-supplied argument — a hostile URL never reaches openExternal', () => {
    const opened: string[] = [];
    const reg = fakeRegistrar();
    registerAppExternalHandlers(reg, { openExternal: (url) => opened.push(url) });

    // A malicious renderer tries to steer the channel to another origin / scheme.
    reg.handlers.get(APP_CHANNELS.openPricingDocs)?.({}, 'https://evil.example.com/phish');
    reg.handlers.get(APP_CHANNELS.openPricingDocs)?.({}, 'file:///etc/passwd');

    // Every open is still the hardcoded constant — no open-arbitrary-URL surface.
    expect(opened).toEqual([ANTHROPIC_PRICING_URL, ANTHROPIC_PRICING_URL]);
  });
});
