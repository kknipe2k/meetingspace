import { useEffect } from 'react';

import type { AppApi } from '@shared/api';

import { useToasts } from '../hooks/useToasts';

/*
 * Full-screen exit affordance (M06.A IRL fix). The native menu bar hides in full screen, so a
 * user who doesn't know F11 is effectively trapped. On entering full screen this raises a
 * persistent app-level toast with a visible Exit control (the M07 toast system, F24); it
 * auto-clears the moment the window leaves full screen. Renders nothing itself — it only drives
 * the toast host. Must be mounted INSIDE ToastProvider (alongside the other app-level toasts).
 */
const FULL_SCREEN_TOAST_KEY = 'fullscreen';

export interface FullScreenToastProps {
  client: Pick<AppApi, 'onFullScreenChange' | 'exitFullScreen'>;
}

export function FullScreenToast({ client }: FullScreenToastProps): null {
  const { show, dismiss } = useToasts();

  useEffect(() => {
    return client.onFullScreenChange((isFullScreen) => {
      if (isFullScreen) {
        show({
          key: FULL_SCREEN_TOAST_KEY,
          variant: 'info',
          message: 'Full screen — press F11 or use the button to exit.',
          action: { label: 'Exit full screen', onClick: () => client.exitFullScreen() },
          durationMs: null,
        });
      } else {
        dismiss(FULL_SCREEN_TOAST_KEY);
      }
    });
  }, [client, show, dismiss]);

  return null;
}
