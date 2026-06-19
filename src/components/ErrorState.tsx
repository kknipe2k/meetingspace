import type { ReactElement } from 'react';

import type { LlmErrorCode } from '@shared/types';

export interface ErrorStateProps {
  /**
   * The user-facing message — a static taxonomy message (LLM) or a plain
   * operation-failed string (storage/search). NEVER a raw error/stack, never the key.
   */
  message: string;
  /** M03 typed taxonomy code; AUTH/NO_KEY (+ onOpenSettings) routes to Open Settings. */
  code?: LlmErrorCode;
  onRetry?(): void;
  onOpenSettings?(): void;
  className?: string;
}

// AUTH / NO_KEY are fixed by re-entering the key (Settings); every other code is
// transient and retryable — the exact split ChatPanel/GeneratedDocView already use.
function isKeyError(code: LlmErrorCode | undefined): boolean {
  return code === 'AUTH' || code === 'NO_KEY';
}

/*
 * The reusable inline error affordance (M05.A) over the M03 typed taxonomy — NO new
 * error model (spec: docs/design-specs/M05A-states.md §0). Covers the surfaces that
 * lack a bespoke one (sidebar list, notes, screenshots, search). For a code-less
 * (storage/search) failure the caller passes only `onRetry` → a plain Retry; for a
 * key error it passes `code` + `onOpenSettings` → Open Settings instead.
 */
export function ErrorState({
  message,
  code,
  onRetry,
  onOpenSettings,
  className,
}: ErrorStateProps): ReactElement {
  const routeToSettings = isKeyError(code) && onOpenSettings !== undefined;

  return (
    <div
      className={className ? `error-state ${className}` : 'error-state'}
      role="alert"
      data-testid="error-state"
    >
      <p className="error-state-message">{message}</p>
      {routeToSettings ? (
        <button
          type="button"
          className="btn btn-secondary error-state-action"
          onClick={onOpenSettings}
        >
          Open Settings
        </button>
      ) : (
        onRetry !== undefined && (
          <button type="button" className="btn btn-secondary error-state-action" onClick={onRetry}>
            Retry
          </button>
        )
      )}
    </div>
  );
}
