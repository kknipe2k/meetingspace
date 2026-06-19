import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateAction {
  readonly label: string;
  onClick(): void;
}

export interface EmptyStateProps {
  /** Optional typographic / SVG illustration slot. */
  icon?: ReactNode;
  headline: string;
  hint?: string;
  /** A single primary action (design.md: one primary action per view). */
  action?: EmptyStateAction;
  className?: string;
}

/*
 * The reusable empty-state primitive (M05.A). A calm, centered "what to do" block
 * reused across the no-session / no-notes / no-screenshots surfaces (spec:
 * docs/design-specs/M05A-states.md §0). Token-driven, one lavender accent on the
 * optional action; `role="note"` so it reads as informational, not an alert.
 */
export function EmptyState({
  icon,
  headline,
  hint,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={className ? `empty-state ${className}` : 'empty-state'}
      role="note"
      data-testid="empty-state"
    >
      {icon !== undefined && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="empty-state-headline">{headline}</p>
      {hint !== undefined && <p className="empty-state-hint">{hint}</p>}
      {action !== undefined && (
        <button
          type="button"
          className="btn btn-primary empty-state-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
