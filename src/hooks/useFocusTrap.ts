import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react';

/*
 * The shared modal focus-trap primitive (M03.A — resolves M02 Finding 1, where the
 * Lightbox/CapturePicker modals over-claimed "focus trap": they did initial-focus +
 * Esc but never contained Tab). This hook does both halves of a real trap:
 *
 *  - lifecycle (useEffect): on open, move focus to the first focusable inside the
 *    dialog (or the dialog itself if it has none); on close, restore focus to the
 *    element that was focused when the dialog opened (the opener).
 *  - containment (returned handler): on Tab/Shift-Tab at an edge, wrap within the
 *    dialog so keyboard focus can never leave it (and never lands behind the scrim).
 *
 * Consumed by Modal; Lightbox, CapturePicker, and SettingsModal all inherit it.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(
  dialogRef: RefObject<HTMLElement>,
): (event: KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const opener = document.activeElement as HTMLElement | null;
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog).focus();

    return () => {
      // Restore focus to the opener so keyboard users land where they left off.
      opener?.focus?.();
    };
  }, [dialogRef]);

  return useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Tab') {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        // Nothing focusable inside — keep focus from leaving the dialog.
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dialogRef],
  );
}
