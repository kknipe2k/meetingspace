import { useCallback, useEffect, useState } from 'react';

import type { SettingsApi } from '@shared/api';
import type { ThemePreference } from '@shared/types';

import { useToasts } from './useToasts';

/*
 * Appearance preference (M06.A IRL fix). A.3 shipped OS-driven dark mode only; the owner asked
 * for an explicit System / Light / Dark choice, persisted, defaulting to System (so the
 * OS-driven behavior is preserved). This hook holds the preference, loads it on mount, applies
 * it as `document.documentElement[data-theme]` (tokens.css then follows the OS for System and
 * overrides it for Light/Dark — no FOUC, since System needs no JS to resolve), and persists a
 * change via settings.setPrefs. No key, no SDK — only the non-secret pref crosses.
 */
export interface ThemeController {
  readonly preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

export function useTheme(settings: Pick<SettingsApi, 'getPrefs' | 'setPrefs'>): ThemeController {
  const [preference, setPref] = useState<ThemePreference>('system');
  const { show } = useToasts();

  useEffect(() => {
    let active = true;
    void settings.getPrefs().then((prefs) => {
      if (active && prefs.themePreference) {
        setPref(prefs.themePreference);
      }
    });
    return () => {
      active = false;
    };
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.theme = preference;
  }, [preference]);

  const setPreference = useCallback(
    (next: ThemePreference): void => {
      setPref(next);
      settings.setPrefs({ themePreference: next }).catch(() => {
        show({ variant: 'error', message: "Couldn't save your appearance preference." });
      });
    },
    [settings, show],
  );

  return { preference, setPreference };
}
