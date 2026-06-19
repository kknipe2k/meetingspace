import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { useToastState } from '../hooks/useToasts';

/*
 * The portal-rendered toast host (M07.B; REVIEW-V11 F24). Mounted once at the app root
 * (App.tsx) so toasts float above every surface — including open modals — and survive a
 * modal's mount/unmount. The container is an aria-live="polite" region; ERROR toasts
 * carry role="alert" so a failure announces assertively and is not missed. Each toast
 * shows its message, an optional inline action (Cancel / Retry / Open Settings), and a
 * dismiss control. Reads the live list off the toast context; renders nothing without a
 * provider (the no-op default), so it is inert in tests that don't opt in.
 */
export function ToastHost(): ReactElement | null {
  const { toasts, dismiss } = useToastState();
  if (typeof document === 'undefined') {
    return null;
  }
  return createPortal(
    <div className="toast-host" data-testid="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.variant}`}
          role={toast.variant === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="btn btn-secondary toast-action"
              onClick={() => toast.action?.onClick()}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="btn-icon toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
