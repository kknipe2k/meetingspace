import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { useFocusTrap } from '../hooks/useFocusTrap';

export interface ModalProps {
  /** Accessible name for the dialog (`aria-label`). */
  label: string;
  /** Class for the dialog box (e.g. `settings-modal`, `lightbox`, `capture-modal`). */
  className: string;
  onClose(): void;
  children: ReactNode;
  /** Extra class on the scrim (e.g. `lightbox-scrim`). */
  scrimClassName?: string;
  scrimTestId?: string;
  /** Default true; Lightbox-style overlays close on a scrim click. */
  closeOnScrimClick?: boolean;
}

/*
 * The shared modal primitive (design.md §4: scrim, shadow-lg, role="dialog",
 * aria-modal, real focus trap). Renders through a top-level portal so it is a
 * sibling of the app root (Lightbox's flicker fix relies on this), owns Esc + a
 * scrim-click close, contains Tab within the dialog, and restores focus to the
 * opener on close (via useFocusTrap). A click inside the dialog never closes it —
 * only the scrim does. Lightbox, CapturePicker, and SettingsModal consume this.
 */
export function Modal({
  label,
  className,
  onClose,
  children,
  scrimClassName,
  scrimTestId,
  closeOnScrimClick = true,
}: ModalProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const containTab = useFocusTrap(dialogRef);
  // Only a press that BEGAN on the scrim is a real backdrop click. A text-selection
  // drag that starts in an input and releases on the scrim must NOT close the modal
  // (it would otherwise fire a scrim `click` and eat the user's edits mid-flight).
  const pressStartedOnScrim = useRef(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    containTab(event);
  };

  const handleScrimMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    pressStartedOnScrim.current = event.target === event.currentTarget;
  };

  const handleScrimClick = (event: MouseEvent<HTMLDivElement>): void => {
    const started = pressStartedOnScrim.current;
    pressStartedOnScrim.current = false;
    if (closeOnScrimClick && started && event.target === event.currentTarget) {
      onClose();
    }
  };

  return createPortal(
    <div
      className={scrimClassName ? `modal-scrim ${scrimClassName}` : 'modal-scrim'}
      data-testid={scrimTestId}
      onMouseDown={handleScrimMouseDown}
      onClick={handleScrimClick}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
