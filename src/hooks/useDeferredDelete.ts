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
 * supersedes the previous one. On unmount the default is to clear pending timers WITHOUT committing
 * — the data-preserving direction (a delete left pending when the view goes away simply doesn't
 * happen; right for note/session/bulk delete). A removal may opt into `onUnmount: 'commit'` to flush
 * instead — closing the view commits the pending delete (Gmail's navigate-away-commits-undo
 * semantics), used by the Settings price-delete so closing Settings doesn't silently cancel it.
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
  /**
   * What happens if the view unmounts while this removal is still pending in its grace window.
   * `'cancel'` (default) clears the timer WITHOUT committing — the delete simply doesn't happen
   * (data-preserving). `'commit'` fires `commit()` immediately from the unmount cleanup, dismisses
   * the toast, and does NOT restore (the UI is gone) — the failure-toast catch still applies.
   */
  readonly onUnmount?: 'commit' | 'cancel';
}

export function useDeferredDelete(): { remove(removal: DeferredRemoval): void } {
  const { show, dismiss } = useToasts();
  // Keep the full removal alongside its timer so the unmount cleanup can honor `onUnmount`.
  const pending = useRef<
    Map<string, { handle: ReturnType<typeof setTimeout>; removal: DeferredRemoval }>
  >(new Map());

  // Latest toast callbacks for the unmount-commit path, so the unmount effect can keep []-deps
  // (its cleanup must run ONLY on real unmount, never on a show/dismiss identity change).
  const showRef = useRef(show);
  const dismissRef = useRef(dismiss);
  showRef.current = show;
  dismissRef.current = dismiss;

  const clearTimer = useCallback((key: string): void => {
    const entry = pending.current.get(key);
    if (entry !== undefined) {
      clearTimeout(entry.handle);
      pending.current.delete(key);
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
        pending.current.delete(removal.key);
        dismiss(removal.key);
        void removal.commit().catch(() => {
          removal.restore();
          show({
            variant: 'error',
            message: removal.errorMessage ?? 'Could not complete the delete.',
          });
        });
      }, grace);
      pending.current.set(removal.key, { handle, removal });
    },
    [show, dismiss, clearTimer],
  );

  // On unmount, resolve each pending removal by its `onUnmount` mode. `'cancel'` (default) clears
  // the timer without committing (data-preserving — byte-unchanged from before). `'commit'` clears
  // the timer, dismisses the toast, and fires commit() now (no restore — the view is gone; the
  // failure-toast catch still applies).
  useEffect(() => {
    const pendingMap = pending.current;
    return () => {
      for (const { handle, removal } of pendingMap.values()) {
        clearTimeout(handle);
        if (removal.onUnmount === 'commit') {
          dismissRef.current(removal.key);
          void removal.commit().catch(() => {
            showRef.current({
              variant: 'error',
              message: removal.errorMessage ?? 'Could not complete the delete.',
            });
          });
        }
      }
      pendingMap.clear();
    };
  }, []);

  return { remove };
}
