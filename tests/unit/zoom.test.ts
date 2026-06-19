import { describe, expect, it } from 'vitest';

import { nextZoomFactor, ZOOM_MAX, ZOOM_MIN } from '../../electron/zoom';

/*
 * The persisted-zoom seam (M06.A; REVIEW-V11 F7). The View menu's Zoom In / Out / Actual Size
 * resolve the next factor here (pure + clamped); main applies it to webContents and persists
 * it in prefs, restoring it on launch.
 */
describe('nextZoomFactor', () => {
  it('steps up on zoom in', () => {
    expect(nextZoomFactor(1, 1)).toBeCloseTo(1.1);
  });

  it('steps down on zoom out', () => {
    expect(nextZoomFactor(1, -1)).toBeCloseTo(0.9);
  });

  it('resets to 1 regardless of the current factor', () => {
    expect(nextZoomFactor(1.7, 0)).toBe(1);
  });

  it('clamps at the maximum', () => {
    expect(nextZoomFactor(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
  });

  it('clamps at the minimum', () => {
    expect(nextZoomFactor(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});
