import { describe, expect, it } from 'vitest';

import { shouldShowOnboarding } from '../../src/onboarding-gate';

/*
 * The first-run gate (M06.E). Onboarding appears ONLY when the app has no credential AND the
 * "seen" flag has not been set — so it shows exactly once and never again after the user
 * completes or skips it (the flag persists in prefs). A returning user with a saved key never
 * sees it even if the flag is somehow absent.
 */
describe('shouldShowOnboarding', () => {
  it('shows on a true first run (no key, never seen)', () => {
    expect(shouldShowOnboarding({}, false)).toBe(true);
  });

  it('does NOT show once the seen flag is set (completed or skipped before)', () => {
    expect(shouldShowOnboarding({ onboardingSeen: true }, false)).toBe(false);
  });

  it('does NOT show when a credential already exists (returning user)', () => {
    expect(shouldShowOnboarding({}, true)).toBe(false);
    expect(shouldShowOnboarding({ onboardingSeen: true }, true)).toBe(false);
  });
});
