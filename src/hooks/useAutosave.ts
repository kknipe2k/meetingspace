import { useCallback, useEffect, useRef } from 'react';

export const AUTOSAVE_DELAY_MS = 500;

export interface AutosaveOptions<T> {
  delayMs?: number;
  // While false, changes are ignored and no save is scheduled. On the
  // false→true edge the current value is adopted as the saved baseline, so
  // asynchronously loaded content is never written straight back to storage.
  enabled?: boolean;
  // Synchronous writer used ONLY by the `pagehide` teardown flush (D-03), so an
  // edit made within the debounce window commits before the renderer is torn down
  // on app quit (the async `save` would still be in the IPC pipe and could be lost).
  // Falls back to `save` when absent.
  saveSync?: (value: T) => void;
}

/*
 * Debounced autosave. Once `value` has been unchanged for `delayMs`, calls
 * `save(value)` exactly once with the latest value; rapid changes within the
 * window collapse into a single trailing save. The value present at mount (or
 * at the moment autosave becomes enabled) is treated as the saved baseline, so
 * neither mounting nor loading existing content triggers a write — only a
 * subsequent edit does.
 *
 * Returns a `flush()` that writes any pending edit immediately (cancelling the
 * debounce). It also runs automatically at unmount, so an edit made within the
 * debounce window is never dropped when the component goes away — e.g. switching
 * sessions unmounts the note block (V-2). Callers wire `flush` to `onBlur` so
 * losing focus persists too; both are no-ops when nothing is pending.
 *
 * On app quit the renderer is torn down without a React unmount, so flush also
 * listens for the Page Lifecycle teardown events (D-03): `pagehide` — the real
 * quit signal — flushes SYNCHRONOUSLY via `saveSync` so the write lands before the
 * window closes; `visibilitychange`→hidden (also fired on ordinary minimize) uses
 * the async flush, cheap and race-free since the app keeps running. Not
 * `beforeunload` (discouraged and less reliable).
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => void,
  options: AutosaveOptions<T> = {},
): () => void {
  const { delayMs = AUTOSAVE_DELAY_MS, enabled = true, saveSync } = options;

  const saveRef = useRef(save);
  saveRef.current = save;
  const saveSyncRef = useRef(saveSync);
  saveSyncRef.current = saveSync;

  const baselineRef = useRef(value);
  const armed = useRef(false);
  const handleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The value awaiting a debounced write, or null when nothing is pending. Held
  // in a ref so flush() (blur / unmount) can write it synchronously, outside the
  // debounce timer, before React tears the component down.
  const pendingRef = useRef<{ value: T } | null>(null);

  // Write any pending edit now, cancelling the debounce. `sync` routes through
  // saveSync (the teardown path that must land before the renderer dies); the
  // async path is the default for blur / unmount / visibility-hidden.
  const commit = useCallback((sync: boolean) => {
    if (handleRef.current !== null) {
      clearTimeout(handleRef.current);
      handleRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending !== null) {
      pendingRef.current = null;
      baselineRef.current = pending.value;
      const saver = sync && saveSyncRef.current ? saveSyncRef.current : saveRef.current;
      saver(pending.value);
    }
  }, []);

  const flush = useCallback(() => commit(false), [commit]);
  const flushSync = useCallback(() => commit(true), [commit]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!armed.current) {
      armed.current = true;
      baselineRef.current = value;
      return;
    }
    if (value === baselineRef.current) {
      // Reverted to the saved baseline within the window — drop the pending write
      // so a later flush can't resurrect a no-longer-current edit.
      pendingRef.current = null;
      return;
    }
    pendingRef.current = { value };
    handleRef.current = setTimeout(() => {
      handleRef.current = null;
      pendingRef.current = null;
      baselineRef.current = value;
      saveRef.current(value);
    }, delayMs);
    return () => {
      if (handleRef.current !== null) {
        clearTimeout(handleRef.current);
        handleRef.current = null;
      }
    };
  }, [value, delayMs, enabled]);

  // Empty deps → this cleanup runs ONLY at unmount (not on every value change,
  // which would defeat the debounce), flushing whatever write is still pending.
  useEffect(() => flush, [flush]);

  // Page Lifecycle teardown (D-03): pagehide fires on app quit → flush SYNC so the
  // write commits before the window closes; visibility-hidden (also ordinary
  // minimize) → async flush, cheap and race-free while the app keeps running.
  useEffect(() => {
    const onPageHide = (): void => flushSync();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flush, flushSync]);

  return flush;
}
