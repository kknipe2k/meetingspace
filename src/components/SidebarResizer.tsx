import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebar-width';

/*
 * Drag-to-resize the left sidebar column (M06.B IRL request). A vertical separator on the
 * sidebar's right edge: pointer-drag sets the new width from the cursor's x; Arrow keys nudge it
 * for keyboard a11y. The parent (App) clamps + applies + persists the width — this component is
 * pure interaction. No key, no IPC. Bounds + clamp live in ./sidebar-width.
 */
const KEYBOARD_STEP = 16;

export interface SidebarResizerProps {
  /** Current sidebar width (px) — also the separator's left offset. */
  width: number;
  /** Live update during a drag (state only — cheap). */
  onResize(width: number): void;
  /** Commit at the end of a drag / on a keyboard nudge (persist). */
  onCommit(width: number): void;
}

export function SidebarResizer({ width, onResize, onCommit }: SidebarResizerProps): ReactElement {
  const dragging = useRef(false);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging.current) {
      onResize(event.clientX);
    }
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit(event.clientX);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      className="sidebar-resizer"
      style={{ left: `${width}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onCommit(width - KEYBOARD_STEP);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onCommit(width + KEYBOARD_STEP);
        }
      }}
    />
  );
}
