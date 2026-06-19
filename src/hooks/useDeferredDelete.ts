import { useCallback, useEffect, useRef } from 'react';

import { useToasts } from './useToasts';

/*
 * Deferred-delete (M06.B, REVIEW-V11 F10 — Gmail-style undo). The ONE mechanism behind note
 * delete, single-session delete, and bulk session delete. The caller removes the item from the UI
 * optimistically and registers the deferred commit here; this hook shows an Undo toast and fires
 * the REAL delete only when the grace window elapses. Undo cancels it (nothing was ever deleted).
 * A commit FAILURE restores the optimistically-removed item to the UI and raises an error toast,
 * so storage and the UI never desync.
 *
 * Pending timers are keyed so several deferrals can be in flight; a re-`remove` of a live key
 * supersedes the previous one. On unmount, pending timers are cleared WITHOUT committing — the
 * data-preserving direction (a delete left pending when the view goes away simply doesn't happen).
 */
const DEFAULT_GRACE_MS = 30000;

export interface DeferredRemoval {
  /** Stable key for this removal's toast/timer (e.g. `note-del-${id}`). */
  readonly key: string;
  /** The undo toast's message (e.g. "Note deleted"). */
  readonly label: string;
  /** The real delete, run when the grace window elapses. */
  commit(): Promise<void>;
  /** Re-add the optimistically-removed item to the UI (on Undo or on commit failure). */
  restore(): void;
  /** Toast text if the real delete fails. */
  readonly errorMessage?: string;
  /** Grace window before the real delete fires; defaults to 6s. */
  readonly graceMs?: number;
}

export function useDeferredDelete(): { remove(removal: DeferredRemoval): void } {
  const { show, dismiss } = useToasts();
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((key: string): void => {
    const handle = timers.current.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(key);
    }
  }, []);

  const remove = useCallback(
    (removal: DeferredRemoval): void => {
      const grace = removal.graceMs ?? DEFAULT_GRACE_MS;
      // Supersede any in-flight deferral under the same key.
      clearTimer(removal.key);

      const undo = (): void => {
        clearTimer(removal.key);
        dismiss(removal.key);
        removal.restore();
      };

      show({
        key: removal.key,
        variant: 'info',
        message: removal.label,
        action: { label: 'Undo', onClick: undo },
        durationMs: null, // persistent — this hook's timer owns the lifecycle
      });

      const handle = setTimeout(() => {
        timers.current.delete(removal.key);
        dismiss(removal.key);
        void removal.commit().catch(() => {
          removal.restore();
          show({
            variant: 'error',
            message: removal.errorMessage ?? 'Could not complete the delete.',
          });
        });
      }, grace);
      timers.current.set(removal.key, handle);
    },
    [show, dismiss, clearTimer],
  );

  // Clear pending timers on unmount WITHOUT committing (data-preserving).
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) {
        clearTimeout(handle);
      }
      pending.clear();
    };
  }, []);

  return { remove };
}
