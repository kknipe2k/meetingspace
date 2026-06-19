import type { WindowState } from '@shared/types';

export type { WindowState } from '@shared/types';

/*
 * Window-state restore validation (M06.A; REVIEW-V11 F4). Persisted size/position are restored
 * on launch, but a saved position must be validated against the CURRENT displays: a window
 * whose bounds lie entirely off every display (a monitor was unplugged / the layout changed)
 * would otherwise restore off-screen and look lost. `resolveWindowOptions` drops the x/y in
 * that case so the window snaps back onto the primary display, while keeping a valid or
 * partially-overlapping position. Pure seam; the resize/move/close save + the
 * screen.getAllDisplays() read are the thin main-process wrapper.
 */
export interface DisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowDefaults {
  readonly width: number;
  readonly height: number;
}

export interface ResolvedWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function intersectsAnyDisplay(rect: Rect, displays: readonly DisplayBounds[]): boolean {
  return displays.some(
    (display) =>
      rect.x < display.x + display.width &&
      rect.x + rect.width > display.x &&
      rect.y < display.y + display.height &&
      rect.y + rect.height > display.y,
  );
}

function validDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveWindowOptions(
  saved: WindowState | undefined,
  displays: readonly DisplayBounds[],
  defaults: WindowDefaults,
): ResolvedWindowOptions {
  const width = validDimension(saved?.width, defaults.width);
  const height = validDimension(saved?.height, defaults.height);

  if (
    saved &&
    typeof saved.x === 'number' &&
    typeof saved.y === 'number' &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    intersectsAnyDisplay({ x: saved.x, y: saved.y, width, height }, displays)
  ) {
    return { width, height, x: saved.x, y: saved.y };
  }

  return { width, height };
}
