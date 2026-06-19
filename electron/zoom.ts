/*
 * Persisted zoom (M06.A; REVIEW-V11 F7). The View menu's Zoom In / Out / Actual Size resolve
 * the next zoom factor here (pure + clamped); main applies it to the focused webContents and
 * persists it in Prefs (`zoomFactor`), restoring it on launch. Kept a seam so the clamp/step
 * logic is Node-unit-testable, separate from the webContents.setZoomFactor wrapper in main.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;

// direction: 1 = zoom in, -1 = zoom out, 0 = reset to 100%.
export function nextZoomFactor(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) {
    return 1;
  }
  const raw = current + direction * ZOOM_STEP;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
  // Avoid binary-float drift accumulating across repeated steps.
  return Math.round(clamped * 100) / 100;
}
