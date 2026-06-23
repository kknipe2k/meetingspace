import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/*
 * The app-level toast system (M07.B; REVIEW-V11 F24). Before this, every notification
 * was an ad-hoc per-component div; M07's generation UX (heartbeat/cancel/ceiling) and
 * M06's (storage nudges, undo, write-failure surfacing) all need ONE portal-rendered,
 * queued host with an optional action button and aria-live built in.
 *
 * Toasts are TRANSIENT — persistent errors keep living in their component ErrorState /
 * role="alert" blocks (don't migrate those). Heartbeat updates REPLACE by key so a
 * 15-minute run updates one toast in place rather than flooding the queue.
 *
 * The context default is a no-op api (so a component calling useToasts outside a
 * provider never crashes — toasts simply don't render); ToastProvider supplies the real
 * stateful api, and ToastHost renders the list.
 */
export type ToastVariant = 'info' | 'progress' | 'warning' | 'error';

export interface ToastInput {
  /** Replace-by-key: a second show() with the same key updates the toast in place. */
  readonly key?: string;
  readonly variant: ToastVariant;
  readonly message: string;
  /** An optional inline action (Cancel / Retry / Open Settings). */
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** ms until auto-dismiss; `null` = persistent; omitted = the default duration. */
  readonly durationMs?: number | null;
}

export interface Toast extends ToastInput {
  readonly id: string;
}

export interface ToastApi {
  /** Show (or replace-by-key) a toast; returns its id (the key when one was given). */
  show(input: ToastInput): string;
  /** Remove a toast by id or by key. */
  dismiss(keyOrId: string): void;
  /** Remove every toast. */
  clear(): void;
}

interface ToastContextValue extends ToastApi {
  readonly toasts: readonly Toast[];
}

const NOOP: ToastContextValue = {
  toasts: [],
  show: () => '',
  dismiss: () => undefined,
  clear: () => undefined,
};

const ToastContext = createContext<ToastContextValue>(NOOP);

const DEFAULT_DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string): void => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (keyOrId: string): void => {
      clearTimer(keyOrId);
      setToasts((prev) => prev.filter((toast) => toast.id !== keyOrId));
    },
    [clearTimer],
  );

  const clear = useCallback((): void => {
    for (const id of timers.current.keys()) {
      clearTimer(id);
    }
    setToasts([]);
  }, [clearTimer]);

  const show = useCallback(
    (input: ToastInput): string => {
      // The key IS the id when given (so replace-by-key keeps a stable identity/position
      // and resets its auto-dismiss); otherwise a fresh sequential id.
      const id = input.key ?? `toast-${(seq.current += 1)}`;
      const durationMs = input.durationMs === undefined ? DEFAULT_DURATION_MS : input.durationMs;
      const toast: Toast = { ...input, id, durationMs };
      setToasts((prev) => {
        const exists = prev.some((t) => t.id === id);
        return exists ? prev.map((t) => (t.id === id ? toast : t)) : [...prev, toast];
      });
      // Reset the auto-dismiss timer on every show (so a replaced progress toast keeps
      // living); a null duration is persistent.
      clearTimer(id);
      if (durationMs !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), durationMs),
        );
      }
      return id;
    },
    [clearTimer, dismiss],
  );

  // Tear down any pending timers on unmount.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) {
        clearTimeout(handle);
      }
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, show, dismiss, clear }}>
      {children}
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook colocated with its provider
export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

// Internal: the host reads the live list + dismiss off the same context.
// eslint-disable-next-line react-refresh/only-export-components -- context hook colocated with its provider
export function useToastState(): { toasts: readonly Toast[]; dismiss: (id: string) => void } {
  const { toasts, dismiss } = useContext(ToastContext);
  return { toasts, dismiss };
}
