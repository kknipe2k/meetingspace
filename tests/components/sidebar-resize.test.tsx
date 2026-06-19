// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SidebarResizer } from '../../src/components/SidebarResizer';
import {
  clampSidebarWidth,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from '../../src/components/sidebar-width';

/*
 * Resizable left sidebar column (M06.B IRL request). The divider drags to set the width and Arrow
 * keys nudge it; the parent clamps + persists. Pointer/keyboard interaction pinned here; the
 * load/apply/persist wiring through App is covered in sidebar-resize-app.
 */
describe('clampSidebarWidth', () => {
  it('clamps to the min/max bounds', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });
});

describe('SidebarResizer', () => {
  function setup() {
    const onResize = vi.fn();
    const onCommit = vi.fn();
    render(<SidebarResizer width={264} onResize={onResize} onCommit={onCommit} />);
    return {
      onResize,
      onCommit,
      handle: screen.getByRole('separator', { name: /resize sidebar/i }),
    };
  }

  it('reports live width during a pointer drag and commits on release', () => {
    const { onResize, onCommit, handle } = setup();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 264 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
    expect(onResize).toHaveBeenLastCalledWith(340);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 340 });
    expect(onCommit).toHaveBeenCalledWith(340);
  });

  it('does not resize on a move that is not part of a drag', () => {
    const { onResize, handle } = setup();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('nudges the width with Arrow keys (keyboard a11y)', () => {
    const { onCommit, handle } = setup();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith(280);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenCalledWith(248);
  });

  it('exposes the current width on the separator for assistive tech', () => {
    const { handle } = setup();
    expect(handle).toHaveAttribute('aria-valuenow', '264');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  });
});
