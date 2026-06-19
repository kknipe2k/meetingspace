import type { Prefs } from '@shared/types';

/*
 * The first-run gate (M06.E). Onboarding appears ONLY when the app has no credential AND the
 * "seen" flag has not been set — so the welcome flow shows exactly once and never again after
 * the user completes or skips it (the flag persists in prefs / settings.json). A returning user
 * with a saved key never sees it. Pure so the rule is unit-tested away from the App wiring.
 */
export function shouldShowOnboarding(
  prefs: Pick<Prefs, 'onboardingSeen'>,
  hasKey: boolean,
): boolean {
  return !hasKey && !prefs.onboardingSeen;
}
