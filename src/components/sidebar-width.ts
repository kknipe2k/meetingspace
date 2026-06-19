/*
 * Sidebar-width bounds + clamp for the resizable left column (M06.B IRL request). Kept in a
 * non-component module so the SidebarResizer component file exports only its component (react-refresh).
 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 264;

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}
