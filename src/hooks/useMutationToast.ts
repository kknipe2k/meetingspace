import { useCallback } from 'react';

import { useToasts } from './useToasts';

/*
 * The F13/F15 surfacing helper (M06.B). Wraps a renderer mutation so a rejected write is never
 * silent — it routes to an app-level error toast with a per-operation message. This is the single
 * pattern every fire-and-forget / catch-less mutation call site now uses; completeness across all
 * sites is enforced by tests/components/mutation-surfacing-guard.test.ts.
 *
 * `surface` resolves to the work's value on success, or `undefined` on failure (after toasting) —
 * so a caller can branch on the result without a try/catch. The message is the user-facing text;
 * keep it generic and truthful (don't claim a cause the error doesn't prove).
 */
export function useMutationToast(): {
  surface<T>(work: Promise<T> | (() => Promise<T>), message: string): Promise<T | undefined>;
} {
  const { show } = useToasts();
  const surface = useCallback(
    async <T>(work: Promise<T> | (() => Promise<T>), message: string): Promise<T | undefined> => {
      try {
        return await (typeof work === 'function' ? work() : work);
      } catch {
        show({ variant: 'error', message });
        return undefined;
      }
    },
    [show],
  );
  return { surface };
}
